// NEXTGEN AI ARENA - browser-side net module (ES module, zero dependencies).
// Deterministic delay-based lockstep transport. No DOM access, no UI strings.
// Speaks the pinned JSON protocol to server.js (the GameServer DurableObject).
//
// connectRoom({...callbacks}) -> control API. The socket auto-reconnects with
// exponential backoff while the page lives; outbound sends are queued until the
// socket is open. Inbound JSON is parsed safely and dispatched to callbacks.
//
// Callbacks (all optional; unknowns ignored):
//   onSeat(msg)          - this client got a playing seat (msg.seat 1|2, .roomId, .players)
//   onSpectate(msg)      - this client is a spectator (seat 0)
//   onStart(msg)         - match start (msg.seed, msg.cfg{p1,p2,stageId,roundsToWin})
//   onInputs(seat,f,m)   - a relayed input frame; may arrive in bursts (catch-up), in order
//   onPeerHash(seat,f,h) - opponent state hash for desync detection
//   onSync(seat,f,state) - ADDITION: P1 snapshot for desync resync (see net-notes.md)
//   onRematch(votes)     - rematch vote tally changed
//   onPeer(event,seat)   - ADDITION: peer join|leave|back (see net-notes.md)
//   onStatus(s)          - 'connecting'|'open'|'reconnecting'|'closed'
//   onError(code,msg)    - server {t:'err'} (e.g. code 'rate')
//
// Returns: { sendInputs, sendHash, sendSync, sendCfg, voteRematch, ping, close, status }

const BACKOFF_MIN = 500;
const BACKOFF_MAX = 8000;

export function connectRoom(opts) {
  opts = opts || {};
  const roomId = opts.roomId;
  const playerId = opts.playerId;

  const fire = (name, ...args) => {
    const fn = opts[name];
    if (typeof fn === 'function') { try { fn(...args); } catch (_) { /* callback threw */ } }
  };

  let ws = null;
  let statusVal = 'connecting';
  let closedByUser = false;
  let everOpened = false;      // distinguishes first connect from a reconnect
  let backoff = BACKOFF_MIN;
  let reconnectTimer = null;
  const queue = [];            // outbound messages buffered while not open
  let lastCfg = null;          // last selection, resent on reconnect if not started
  let gotStart = false;

  function setStatus(s) { statusVal = s; fire('onStatus', s); }

  function buildUrl() {
    const proto = (typeof location !== 'undefined' && location.protocol === 'https:') ? 'wss://' : 'ws://';
    const host = location.host;
    const path = location.pathname.replace(/\/$/, '');
    return proto + host + path + '/ws/' + roomId;
  }

  function rawSend(obj) {
    // returns true if actually sent, false if it should be queued
    if (ws && ws.readyState === 1) {
      try { ws.send(JSON.stringify(obj)); return true; } catch (_) { return false; }
    }
    return false;
  }

  function send(obj) {
    if (!rawSend(obj)) queue.push(obj);
  }

  function flush() {
    while (queue.length) {
      const m = queue[0];
      if (!rawSend(m)) break; // socket closed mid-flush; keep the rest queued
      queue.shift();
    }
  }

  function open() {
    if (closedByUser) return;
    let sock;
    try { sock = new WebSocket(buildUrl()); } catch (_) { scheduleReconnect(); return; }
    ws = sock;

    sock.onopen = () => {
      if (ws !== sock) { try { sock.close(); } catch (_) {} return; }
      backoff = BACKOFF_MIN;
      setStatus('open');
      // (Re)claim the seat. On a reconnect the server sends a state catch-up.
      rawSend({ t: 'join', playerId });
      // Cover the rare case the previous socket died before the server got our cfg.
      if (everOpened && lastCfg && !gotStart) rawSend({ t: 'cfg', ...lastCfg });
      everOpened = true;
      flush();
    };

    sock.onmessage = (evt) => onMessage(evt.data);

    sock.onclose = () => {
      if (ws === sock) ws = null;
      if (closedByUser) { setStatus('closed'); return; }
      setStatus('reconnecting');
      scheduleReconnect();
    };

    sock.onerror = () => { try { sock.close(); } catch (_) {} };
  }

  function scheduleReconnect() {
    if (closedByUser) return;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(open, backoff);
    backoff = Math.min(backoff * 2, BACKOFF_MAX);
  }

  function onMessage(raw) {
    let m;
    try { m = JSON.parse(typeof raw === 'string' ? raw : ''); } catch (_) { return; }
    if (!m || typeof m.t !== 'string') return;

    switch (m.t) {
      case 'seat':
        if (m.seat === 0) fire('onSpectate', m); else fire('onSeat', m);
        break;
      case 'start':
        gotStart = true;
        fire('onStart', m);
        break;
      case 'in':
        fire('onInputs', m.seat, m.f, m.m);
        break;
      case 'hash':
        fire('onPeerHash', m.seat, m.f, m.h);
        break;
      case 'sync':
        fire('onSync', m.seat, m.f, m.state);
        break;
      case 'rematch':
        fire('onRematch', m.votes);
        break;
      case 'peer':
        fire('onPeer', m.event, m.seat);
        break;
      case 'err':
        fire('onError', m.code, m.msg);
        break;
      case 'pong':
        break;
      default:
        break;
    }
  }

  // ---- public control API --------------------------------------------------
  const api = {
    sendInputs(frame, mask) { send({ t: 'in', f: frame | 0, m: mask | 0 }); },
    sendHash(frame, h) { send({ t: 'hash', f: frame | 0, h: h >>> 0 }); },
    sendSync(frame, stateObj) { send({ t: 'sync', f: frame | 0, state: stateObj }); },
    sendCfg(fighterId, stageVote, roundsToWin) {
      lastCfg = { fighterId, stageVote, roundsToWin: roundsToWin | 0 };
      send({ t: 'cfg', fighterId, stageVote, roundsToWin: roundsToWin | 0 });
    },
    voteRematch() { send({ t: 'rematch' }); },
    ping() { send({ t: 'ping' }); },
    close() {
      closedByUser = true;
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      if (ws) { try { ws.close(); } catch (_) {} ws = null; }
      setStatus('closed');
    },
    status() { return statusVal; }
  };

  setStatus('connecting');
  open();
  return api;
}
