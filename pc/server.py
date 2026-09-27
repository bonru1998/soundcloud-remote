#!/usr/bin/env python3
"""SoundCloud Remote: dependency-free LAN relay. Python 3.10+."""
import argparse
import collections
import ipaddress
import json
import os
from pathlib import Path
import secrets
import socket
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parent.parent
COMMANDS = {'toggle', 'play', 'pause', 'previous', 'next', 'shuffle', 'repeat', 'like',
            'seekBy', 'seekTo', 'volume', 'mute', 'search', 'likes', 'playlists', 'history'}


class Relay:
    def __init__(self, config_path):
        self.lock = threading.RLock()
        self.path = Path(config_path)
        if self.path.exists():
            self.config = json.loads(self.path.read_text())
        else:
            self.config = {k: secrets.token_urlsafe(32) for k in ('phone', 'bridge')}
            self.path.parent.mkdir(parents=True, exist_ok=True)
            self.path.write_text(json.dumps(self.config))
            try: self.path.chmod(0o600)
            except OSError: pass
        self.code = f'{secrets.randbelow(1000000):06d}'
        self.pair_until = time.monotonic() + 600
        self.attempts = collections.defaultdict(list)
        self.queue = collections.deque()
        self.pending = {}
        self.state = {}
        self.seen = 0
        self.sleep_at = 0

    def enqueue(self, command):
        now = time.monotonic()
        item = {'id': secrets.token_hex(8), 'command': command, 'expires': now+8,
                'event': threading.Event(), 'result': None}
        with self.lock:
            if len(self.pending) >= 30: raise ValueError('Too many pending commands')
            self.pending[item['id']] = item
            self.queue.append(item)
        return item

    def snapshot(self):
        with self.lock:
            return {'ok': True, 'connected': time.monotonic()-self.seen < 6,
                    'device': socket.gethostname(), 'state': self.state,
                    'sleepRemaining': max(0, int(self.sleep_at-time.monotonic())) if self.sleep_at else 0}


def validate_command(data):
    if not isinstance(data, dict) or data.get('type') not in COMMANDS | {'sleep'}:
        raise ValueError('Unknown command')
    kind = data['type']
    result = {'type': kind}
    if kind in ('seekBy', 'seekTo', 'volume', 'sleep'):
        value = data.get('value')
        if type(value) not in (int, float): raise ValueError('A number is required')
        low, high = {'seekBy': (-60, 60), 'seekTo': (0, 1), 'volume': (0, 1), 'sleep': (0, 180)}[kind]
        if not low <= value <= high: raise ValueError('Value out of range')
        result['value'] = value
    if kind == 'search':
        query = str(data.get('value', '')).strip()
        if not query or len(query) > 200: raise ValueError('Enter a search up to 200 characters')
        result['value'] = query
    return result


class Handler(BaseHTTPRequestHandler):
    server_version = 'SoundCloudRemote/1.0'

    def log_message(self, *_): pass

    def send_json(self, status, data):
        body = json.dumps(data).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.end_headers()
        try: self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError): pass

    def valid_request(self):
        # Literal LAN/loopback addresses only: prevents DNS rebinding.
        host = self.headers.get('Host', '').split(':')[0]
        try:
            address = ipaddress.ip_address(host)
            if not (address.is_private or address.is_loopback): return False
        except ValueError:
            if host != 'localhost': return False
        origin = self.headers.get('Origin')
        if origin:
            parsed = urlsplit(origin)
            if parsed.scheme == 'chrome-extension': return True
            if origin != 'http://' + self.headers.get('Host', ''): return False
        return True

    def authorized(self, role):
        expected = 'Bearer ' + self.server.relay.config[role]
        return secrets.compare_digest(self.headers.get('Authorization', ''), expected)

    def do_GET(self):
        if not self.valid_request(): return self.send_json(403, {'error': 'Request denied'})
        path = urlsplit(self.path).path
        if path == '/api/local-info':
            if not ipaddress.ip_address(self.client_address[0]).is_loopback:
                return self.send_json(403, {'error': 'PC only'})
            return self.send_json(200, {'ok': True, 'token': self.server.relay.config['bridge']})
        if path == '/api/state':
            if not self.authorized('phone'): return self.send_json(401, {'error': 'Pair this phone again'})
            return self.send_json(200, self.server.relay.snapshot())
        files = {'/': ('index.html', 'text/html'), '/app.js': ('app.js', 'text/javascript'),
                 '/style.css': ('style.css', 'text/css'), '/icon.svg': ('icon.svg', 'image/svg+xml')}
        if path not in files: return self.send_json(404, {'error': 'Not found'})
        name, mime = files[path]
        data = (ROOT/'ui'/name).read_bytes()
        self.send_response(200)
        self.send_header('Content-Type', mime+'; charset=utf-8')
        self.send_header('Content-Length', str(len(data)))
        self.send_header('X-Frame-Options', 'DENY')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Content-Security-Policy', "default-src 'self'; img-src 'self' https://*.sndcdn.com; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'")
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        if not self.valid_request(): return self.send_json(403, {'error': 'Request denied'})
        try:
            size = int(self.headers.get('Content-Length', 0))
            if size < 1 or size > 32768: raise ValueError('Invalid request size')
            if self.headers.get('Content-Type', '').split(';')[0] != 'application/json':
                raise ValueError('JSON required')
            data = json.loads(self.rfile.read(size))
            if not isinstance(data, dict): raise ValueError('JSON object required')
        except (ValueError, json.JSONDecodeError):
            return self.send_json(400, {'error': 'Invalid JSON request'})
        relay = self.server.relay
        path = urlsplit(self.path).path
        now = time.monotonic()
        if path == '/api/pair':
            with relay.lock:
                for key in (self.client_address[0], '*'):
                    relay.attempts[key] = [t for t in relay.attempts[key] if t > now-60]
                if len(relay.attempts[self.client_address[0]]) >= 5 or len(relay.attempts['*']) >= 20:
                    return self.send_json(429, {'error': 'Too many attempts. Wait one minute.'})
                relay.attempts[self.client_address[0]].append(now)
                relay.attempts['*'].append(now)
                if now > relay.pair_until:
                    return self.send_json(403, {'error': 'Code expired. Restart the PC helper for a new code.'})
                if not secrets.compare_digest(str(data.get('code', '')), relay.code):
                    return self.send_json(403, {'error': 'Incorrect pairing code'})
            return self.send_json(200, {'ok': True, 'token': relay.config['phone']})
        if path == '/api/bridge':
            if not self.authorized('bridge'): return self.send_json(401, {'error': 'Pair extension again'})
            with relay.lock:
                for answer in data.get('results', [])[:30]:
                    if not isinstance(answer, dict): continue
                    item = relay.pending.get(str(answer.get('id')))
                    if item:
                        item['result'] = {'ok': bool(answer.get('ok')), 'error': str(answer.get('error', ''))[:300]}
                        item['event'].set()
                state = data.get('state')
                if isinstance(state, dict):
                    relay.state = state
                    relay.seen = now
                else:
                    relay.seen = 0
                if relay.sleep_at and now >= relay.sleep_at and state is not None:
                    relay.sleep_at = 0
                    item = relay.enqueue({'type': 'pause'})
                    item['internal'] = True
                commands = []
                while relay.queue:
                    item = relay.queue.popleft()
                    if item['expires'] > now:
                        commands.append({'id': item['id'], **item['command']})
                for key, item in list(relay.pending.items()):
                    if item['expires'] <= now or (item.get('internal') and item['event'].is_set()):
                        relay.pending.pop(key, None)
            return self.send_json(200, {'ok': True, 'commands': commands})
        if path != '/api/command': return self.send_json(404, {'error': 'Not found'})
        if not self.authorized('phone'): return self.send_json(401, {'error': 'Pair this phone again'})
        try:
            command = validate_command(data)
            if command['type'] == 'sleep':
                with relay.lock: relay.sleep_at = now+command['value']*60 if command['value'] else 0
                return self.send_json(200, {'ok': True})
            if not relay.snapshot()['connected']:
                return self.send_json(409, {'error': 'Connect the extension to an open SoundCloud tab first'})
            item = relay.enqueue(command)
            item['event'].wait(8)
            with relay.lock: relay.pending.pop(item['id'], None)
            if item['result'] is None:
                return self.send_json(504, {'error': 'PC did not confirm. Check SoundCloud before retrying.'})
            return self.send_json(200 if item['result']['ok'] else 422, item['result'])
        except ValueError as exc: return self.send_json(400, {'error': str(exc)})


def addresses():
    result = set()
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(('192.0.2.1', 80))
            result.add(s.getsockname()[0])
    except OSError: pass
    try: result.update(socket.gethostbyname_ex(socket.gethostname())[2])
    except OSError: pass
    return sorted(x for x in result if not x.startswith('127.'))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--port', type=int, default=8765)
    parser.add_argument('--bind', default='0.0.0.0')
    parser.add_argument('--reset', action='store_true', help='Revoke all paired phones and extensions')
    args = parser.parse_args()
    config = Path(os.environ.get('LOCALAPPDATA', str(Path.home())))/'SoundCloudRemote'/'pairing.json'
    if args.reset: config.unlink(missing_ok=True)
    relay = Relay(config)
    try: server = ThreadingHTTPServer((args.bind, args.port), Handler)
    except OSError as exc:
        print('Cannot start helper:', exc)
        return
    server.relay = relay
    print('\n  SOUNDCLOUD REMOTE — PC helper\n')
    for addr in addresses(): print(f'  PC address: {addr}:{args.port}')
    print(f'  Pairing code: {relay.code}  (valid for 10 minutes)')
    print('\n  Keep this window open. Connect both devices to your home Wi-Fi.')
    print('  Allow Python through Windows Firewall on PRIVATE networks only.')
    print('  Then open SoundCloud and click Connect in the browser extension.')
    print('  Press Ctrl+C to stop. Use --reset to revoke paired devices.\n', flush=True)
    try: server.serve_forever()
    except KeyboardInterrupt: pass
    finally: server.server_close()


if __name__ == '__main__': main()
