import concurrent.futures
import importlib.util
import json
from pathlib import Path
import tempfile
import threading
import time
import unittest
import urllib.request
import urllib.error

spec = importlib.util.spec_from_file_location('relay', Path(__file__).parents[1]/'pc/server.py')
relay = importlib.util.module_from_spec(spec)
spec.loader.exec_module(relay)

class RelayTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.state = relay.Relay(Path(self.temp.name)/'config.json')
        self.server = relay.ThreadingHTTPServer(('127.0.0.1',0),relay.Handler)
        self.server.relay=self.state
        threading.Thread(target=self.server.serve_forever,daemon=True).start()
        self.base='http://127.0.0.1:'+str(self.server.server_port)

    def tearDown(self):
        self.server.shutdown();self.server.server_close();self.temp.cleanup()

    def request(self,path,data=None,role=None,extra=None):
        headers={'Content-Type':'application/json'}
        if role:headers['Authorization']='Bearer '+self.state.config[role]
        headers.update(extra or {})
        req=urllib.request.Request(self.base+path, data=json.dumps(data).encode() if data is not None else None,headers=headers)
        try:
            with urllib.request.urlopen(req,timeout=10) as r:return r.status,json.load(r)
        except urllib.error.HTTPError as e:return e.code,json.load(e)

    def test_pairing_rate_limit_and_auth_roles(self):
        self.assertEqual(self.request('/api/state')[0],401)
        self.assertEqual(self.request('/api/state',role='bridge')[0],401)
        status,data=self.request('/api/pair',{'code':self.state.code})
        self.assertEqual(status,200);self.assertEqual(data['token'],self.state.config['phone'])
        for _ in range(4):self.assertEqual(self.request('/api/pair',{'code':'bad'})[0],403)
        self.assertEqual(self.request('/api/pair',{'code':'bad'})[0],429)

    def test_expiry_origin_and_input_validation(self):
        self.state.pair_until=0
        self.assertEqual(self.request('/api/pair',{'code':self.state.code})[0],403)
        self.assertEqual(self.request('/api/state',role='phone',extra={'Origin':'https://evil.example'})[0],403)
        self.assertEqual(self.request('/api/state',role='phone',extra={'Host':'evil.example'})[0],403)
        for command in [{'type':'shell'},{'type':'volume','value':5},{'type':'seekTo','value':float('nan')}]:
            self.assertEqual(self.request('/api/command',command,'phone')[0],400)

    def test_acknowledged_command_roundtrip(self):
        self.request('/api/bridge',{'state':{'title':'Test','playing':True}},'bridge')
        with concurrent.futures.ThreadPoolExecutor() as pool:
            future=pool.submit(self.request,'/api/command',{'type':'next'},'phone')
            for _ in range(100):
                if self.state.queue:break
                time.sleep(.01)
            status,data=self.request('/api/bridge',{'state':{'title':'Test'}},'bridge')
            self.assertEqual(status,200);self.assertEqual(data['commands'][0]['type'],'next')
            self.request('/api/bridge',{'state':{'title':'Next'},'results':[{'id':data['commands'][0]['id'],'ok':True}]},'bridge')
            self.assertEqual(future.result(),(200,{'ok':True,'error':''}))
        self.assertEqual(self.request('/api/state',role='phone')[1]['state']['title'],'Next')
        self.assertEqual(len(self.state.pending),0)

    def test_disconnect_and_timer(self):
        self.assertEqual(self.request('/api/command',{'type':'toggle'},'phone')[0],409)
        self.assertEqual(self.request('/api/command',{'type':'sleep','value':15},'phone')[0],200)
        self.state.sleep_at=time.monotonic()-1
        _,data=self.request('/api/bridge',{'state':{'playing':True}},'bridge')
        self.assertEqual(data['commands'][0]['type'],'pause')
        self.assertEqual(self.state.sleep_at,0)
        self.request('/api/bridge',{'state':None},'bridge')
        self.assertFalse(self.request('/api/state',role='phone')[1]['connected'])

if __name__=='__main__':unittest.main(verbosity=2)
