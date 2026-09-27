(() => {
  const $ = s => document.querySelector(s);
  const selectors = {
    toggle: '.playControls__play', previous: '.playControls__prev', next: '.playControls__next',
    shuffle: '.playControls__shuffle button', repeat: '.playControls__repeat button',
    like: '.playbackSoundBadge__like', mute: '.volume__button'
  };
  const active = el => !!el && (el.getAttribute('aria-pressed') === 'true' ||
    /(?:^|\s)(?:playing|m-active|m-playing|m-shuffling|m-repeating|m-one|m-all|sc-button-pause|sc-button-selected)(?:\s|$)/.test(el.className));
  const time = s => {
    const pieces = (s || '').trim().split(':').map(Number);
    return pieces.every(Number.isFinite) ? pieces.reduce((n, x) => n*60+x, 0) : 0;
  };
  function snapshot() {
    const title = $('.playbackSoundBadge__titleLink');
    const avatar = $('.playbackSoundBadge__avatar span') || $('.playbackSoundBadge__avatar');
    const bg = avatar ? getComputedStyle(avatar).backgroundImage : '';
    const match = bg.match(/url\(["']?(https:\/\/[^"')]+)["']?\)/);
    const slider = $('.volume__sliderWrapper');
    const progress = $('.volume__sliderProgress');
    let volume = slider ? Number(slider.getAttribute('aria-valuenow')) : NaN;
    if (Number.isFinite(volume) && volume > 1) volume /= 100;
    if (!slider || slider.getAttribute('aria-valuenow') === null) {
      const percentage = progress?.style.height;
      volume = percentage?.endsWith('%') ? parseFloat(percentage)/100 : null;
    }
    const elapsed = $('.playbackTimeline__timePassed [aria-hidden="true"]') || $('.playbackTimeline__timePassed');
    const duration = $('.playbackTimeline__duration [aria-hidden="true"]') || $('.playbackTimeline__duration');
    const timeline = $('.playbackTimeline__progressWrapper');
    const elapsedSeconds = timeline?.hasAttribute('aria-valuenow') ? Number(timeline.getAttribute('aria-valuenow')) : time(elapsed?.textContent);
    const durationText = duration?.textContent?.trim() || '';
    const durationSeconds = timeline?.hasAttribute('aria-valuemax') ? Number(timeline.getAttribute('aria-valuemax')) : (/^[−-]/.test(durationText) ? elapsedSeconds+time(durationText.replace(/^[−-]/,'')) : time(durationText));
    return {
      title: (title?.getAttribute('title') || title?.textContent || 'Start a track on your PC').trim(),
      artist: ($('.playbackSoundBadge__lightLink')?.textContent || 'SoundCloud').trim(),
      artwork: match ? match[1] : '', playing: active($(selectors.toggle)),
      elapsed: elapsedSeconds, duration: durationSeconds,
      volume, muted: !!$('.volume.muted, .volume.m-muted'), liked: active($(selectors.like)),
      shuffle: active($(selectors.shuffle)), repeat: active($(selectors.repeat)),
      available: Object.fromEntries(Object.entries(selectors).map(([k,s]) => [k, !!$(s)])),
      seekAvailable: !!$('.playbackTimeline.is-scrubbable .playbackTimeline__progressWrapper'),
      volumeAvailable: !!$('.volume__sliderWrapper')
    };
  }
  function click(selector) {
    const el = $(selector);
    if (!el || el.disabled || el.classList.contains('disabled') || el.classList.contains('sc-button-disabled') || el.getAttribute('aria-disabled') === 'true') throw Error('This control is not available for the current track.');
    el.click();
  }
  function drag(el, x, y) {
    el.dispatchEvent(new MouseEvent('mousedown', {bubbles:true, clientX:x, clientY:y, button:0, buttons:1}));
    document.dispatchEvent(new MouseEvent('mousemove', {bubbles:true, clientX:x, clientY:y, buttons:1}));
    document.dispatchEvent(new MouseEvent('mouseup', {bubbles:true, clientX:x, clientY:y, button:0}));
    el.dispatchEvent(new MouseEvent('click', {bubbles:true, clientX:x, clientY:y, button:0}));
  }
  function execute(command) {
    const kind = command.type;
    if (kind in selectors) click(selectors[kind]);
    else if (kind === 'play') { if (!snapshot().playing) click(selectors.toggle); }
    else if (kind === 'pause') { if (snapshot().playing) click(selectors.toggle); }
    else if (kind === 'seekBy' || kind === 'seekTo') {
      const state = snapshot();
      if (!state.duration) throw Error('This track cannot be seeked yet.');
      const el = $('.playbackTimeline__progressWrapper');
      if (!el) throw Error('SoundCloud seek control unavailable.');
      const ratio = kind === 'seekTo' ? command.value : (state.elapsed + command.value)/state.duration;
      const rect = el.getBoundingClientRect();
      drag(el, rect.left + Math.max(0, Math.min(1, ratio))*rect.width, rect.top+rect.height/2);
    } else if (kind === 'volume') {
      const wrapper = $('.volume');
      const el = $('.volume__sliderWrapper');
      if (!el) throw Error('SoundCloud volume control unavailable.');
      const alreadyOpen = wrapper?.classList.contains('expanded');
      wrapper?.classList.add('expanded');
      const background = $('.volume__sliderBackground') || el;
      const rect = background.getBoundingClientRect();
      if (!rect.height) throw Error('Open the SoundCloud volume slider once on your PC.');
      drag(el, rect.left+rect.width/2, rect.bottom+4-Math.max(0,Math.min(1,command.value))*rect.height);
      if (!alreadyOpen) wrapper?.classList.remove('expanded');
    } else {
      const pages = {likes: '/you/likes', playlists: '/you/sets', history: '/you/history'};
      const path = kind === 'search' ? '/search?q='+encodeURIComponent(command.value) : pages[kind];
      if (!path) throw Error('Unknown command');
      // Real SoundCloud anchor navigation preserves its SPA player when possible.
      const a = document.createElement('a');
      a.href = 'https://soundcloud.com'+path;
      document.body.appendChild(a);
      a.click();
      a.remove();
    }
    return {ok: true};
  }
  chrome.runtime.onMessage.addListener((message, _sender, reply) => {
    if (message.action === 'state') { reply(snapshot()); return; }
    if (message.action === 'command') {
      try { reply(execute(message.command)); }
      catch (error) { reply({ok:false, error:error.message}); }
    }
  });
  chrome.runtime.sendMessage({action:'wake'}).catch(() => {});
})();
