// MiniCast prototype: Firebase + WebRTC signaling + simple chat

// TODO: Replace with your Firebase project config
const firebaseConfig = {
  apiKey: "AIzaSyATxGuyaf4VdfvCIZnR1b9S4oxU0Bg4Hnc",
  authDomain: "mitch-live-charfxd.firebaseapp.com",
  projectId: "mitch-live-charfxd",
  storageBucket: "mitch-live-charfxd.firebasestorage.app",
  messagingSenderId: "1021938212551",
  appId: "1:1021938212551:web:6939fef647afd42fdce8e2",
    databaseURL: "https://mitch-live-charfxd-default-rtdb.firebaseio.com",
};

firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();
const db = firebase.database();

// UI refs
const emailEl = document.getElementById('email');
const passwordEl = document.getElementById('password');
const signupBtn = document.getElementById('signup');
const signinBtn = document.getElementById('signin');
const signoutBtn = document.getElementById('signout');

const startBroadcastBtn = document.getElementById('start-broadcast');
const stopBroadcastBtn = document.getElementById('stop-broadcast');
const createRoomBtn = document.getElementById('create-room');
const copyRoomBtn = document.getElementById('copy-room');
const roomIdInput = document.getElementById('room-id');

const joinRoomBtn = document.getElementById('join-room');
// single public room id (no per-room ids):
const PUBLIC_ROOM = 'public-room';

const localVideo = document.getElementById('localVideo');
const remoteVideo = document.getElementById('remoteVideo');

const messagesEl = document.getElementById('messages');
const messageInput = document.getElementById('message-input');
const sendMsgBtn = document.getElementById('send-message');

let localStream = null;
let roomId = PUBLIC_ROOM;
let liveRef = db.ref(`rooms/${PUBLIC_ROOM}/live`);

const liveListEl = document.getElementById('live-list');
const presenceStatusEl = document.createElement('div');
presenceStatusEl.style.fontSize = '12px'; presenceStatusEl.style.color = '#666';
if (liveListEl && liveListEl.parentNode) liveListEl.parentNode.appendChild(presenceStatusEl);

function logSignal(msg) {
  try { console.log(msg); if (presenceStatusEl) presenceStatusEl.textContent = msg; } catch (e) {}
}

function renderLiveItem(key, val) {
  const div = document.createElement('div');
  div.id = 'live-' + key;
  const label = val && (val.author || val.label) ? (val.author || val.label) : key;
  const ts = val && val.ts ? ` (${new Date(val.ts).toLocaleTimeString()})` : '';
  div.textContent = label + ts;
  div.style.cursor = 'pointer';
  div.title = 'Click to view this streamer';
  div.addEventListener('click', () => startViewing(key, label));
  return div;
}

function clearLiveList() { if (liveListEl) liveListEl.innerHTML = ''; }

// Incremental listeners
clearLiveList();
liveRef.on('child_added', snap => {
  const k = snap.key; const v = snap.val();
  if (!liveListEl) return;
  // avoid duplicates
  if (document.getElementById('live-' + k)) return;
  liveListEl.appendChild(renderLiveItem(k, v));
});
liveRef.on('child_removed', snap => {
  const k = snap.key; const el = document.getElementById('live-' + k);
  if (el && el.parentNode) el.parentNode.removeChild(el);
  // if nothing left, show placeholder
  if (liveListEl && !liveListEl.children.length) liveListEl.textContent = '(no one live)';
  // if viewers are connected to this streamer, clean up their PCs
  if (viewerPCs[k]) {
    try { if (viewerPCs[k]._cleanup) viewerPCs[k]._cleanup(); } catch (e) {}
  }
});

// --- Signaling structures
const signalsRoot = db.ref(`rooms/${PUBLIC_ROOM}/signals`);
// Basic ICE servers config (add TURN for production)
const RTC_CONFIG = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };
const streamerPCs = {}; // streamer-side PCs keyed by viewerId
const viewerPCs = {}; // viewer-side PCs keyed by viewerId

// Streamer: listen for offers for current live id
let offersListenerRef = null;
function startListeningForOffers(liveId) {
  if (!liveId) return;
  offersListenerRef = signalsRoot.child(`${liveId}/offers`);
  offersListenerRef.on('child_added', async snap => {
    const viewerId = snap.key; const offerObj = snap.val();
    logSignal(`Streamer: received offer for viewer ${viewerId}`);
    if (!offerObj || !offerObj.sdp) return;
    if (streamerPCs[viewerId]) return; // already answering
    try {
  const pc = new RTCPeerConnection(RTC_CONFIG);
      streamerPCs[viewerId] = pc;
      // add local tracks to send to viewer
      if (localStream) localStream.getTracks().forEach(t => pc.addTrack(t, localStream));
      // streamer ICE -> write to answers/{viewerId}/candidates
      const answerCandidatesRef = signalsRoot.child(`${liveId}/answers/${viewerId}/candidates`);
  pc.onicecandidate = event => { if (event.candidate) { answerCandidatesRef.push(event.candidate.toJSON()); logSignal(`Streamer: pushed ICE candidate for ${viewerId}`); } };
  pc.oniceconnectionstatechange = () => { console.log('Streamer PC iceState', pc.iceConnectionState); };
      // listen for viewer ICE candidates
      const offerCandidatesRef = signalsRoot.child(`${liveId}/offers/${viewerId}/candidates`);
      offerCandidatesRef.on('child_added', cSnap => {
        const c = cSnap.val(); if (c) pc.addIceCandidate(new RTCIceCandidate(c)).catch(e=>console.warn('addIceCandidate streamer', e));
        logSignal(`Streamer: received viewer ICE candidate for ${viewerId}`);
      });
      // set remote (viewer) offer
      await pc.setRemoteDescription({ type: 'offer', sdp: offerObj.sdp });
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      // write answer
  await signalsRoot.child(`${liveId}/answers/${viewerId}`).set({ sdp: pc.localDescription.sdp });
  logSignal(`Streamer: answered viewer ${viewerId}`);
    } catch (e) { console.error('Error handling offer', e); }
  });
}

function stopListeningForOffers(liveId) {
  if (!liveId) return;
  if (offersListenerRef) offersListenerRef.off();
  Object.keys(streamerPCs).forEach(k => { try { streamerPCs[k].close(); } catch (e){} delete streamerPCs[k]; });
}

// Viewer: start viewing a streamer (streamerId is the live id)
async function startViewing(streamerId, label) {
  if (!streamerId) return;
  // create a viewer id for this client
  // create a unique viewer id for this viewing session
  const viewerId = (auth.currentUser ? auth.currentUser.uid : 'viewer') + '-' + Date.now();
  // cleanup any existing viewer PC for this streamer
  if (viewerPCs[streamerId]) { try { viewerPCs[streamerId].close(); } catch (e){} delete viewerPCs[streamerId]; }
  const pc = new RTCPeerConnection(RTC_CONFIG);
  // prefer to receive only (viewer) — add recvonly transceivers so remote tracks are negotiated
  try { pc.addTransceiver('video', { direction: 'recvonly' }); pc.addTransceiver('audio', { direction: 'recvonly' }); } catch (e) { /* not critical */ }
  viewerPCs[streamerId] = pc;
  // remote stream -> remoteVideo
  const remoteStream = new MediaStream();
  if (remoteVideo) {
    // clear any previous srcObject safely
    try { if (remoteVideo.srcObject) { const s = remoteVideo.srcObject; if (s.getTracks) s.getTracks().forEach(t=>t.stop()); } } catch(e){}
    remoteVideo.srcObject = remoteStream;
    // allow user to toggle mute by clicking the video
    remoteVideo.addEventListener('click', () => { remoteVideo.muted = !remoteVideo.muted; });
  }
  pc.ontrack = (ev) => {
    try {
      if (ev.streams && ev.streams[0]) {
        remoteVideo.srcObject = ev.streams[0];
      } else {
        remoteStream.addTrack(ev.track);
      }
      // ensure playback after tracks arrive
      remoteVideo.muted = false;
      try { remoteVideo.play().catch(()=>{}); } catch(e){}
      // audio fallback: attach audio tracks to a hidden audio element and play
      try {
        const stream = ev.streams && ev.streams[0] ? ev.streams[0] : remoteStream;
        const audioTracks = stream.getAudioTracks();
        if (audioTracks && audioTracks.length) {
          console.log('Remote audio tracks arrived:', audioTracks.map(t=>t.label||t.kind));
          let audioEl = document.getElementById('remoteAudioFallback');
          if (!audioEl) {
            audioEl = document.createElement('audio');
            audioEl.id = 'remoteAudioFallback'; audioEl.style.display = 'none'; audioEl.autoplay = true; audioEl.controls = false;
            document.body.appendChild(audioEl);
          }
          audioEl.srcObject = stream;
          audioEl.muted = false;
          try { audioEl.play().catch(()=>{}); } catch(e){}
        } else {
          console.log('No remote audio tracks in received stream');
        }
      } catch(e) { console.warn('audio fallback error', e); }
    } catch (e) { console.warn('ontrack error', e); }
  };
  // viewer ICE -> write to offers/{viewerId}/candidates
  const offerCandidatesRef = signalsRoot.child(`${streamerId}/offers/${viewerId}/candidates`);
  pc.onicecandidate = event => { if (event.candidate) { offerCandidatesRef.push(event.candidate.toJSON()); logSignal(`Viewer: pushed ICE candidate for ${viewerId} -> ${streamerId}`); } };
  pc.oniceconnectionstatechange = () => { console.log('Viewer PC iceState', pc.iceConnectionState); };

  // create offer (guard against PC closed)
  try {
    if (pc.signalingState === 'closed') {
      console.warn('Viewer: PC was closed before createOffer, recreating');
      try { pc.close(); } catch(e){}
      const newPc = new RTCPeerConnection(RTC_CONFIG);
      try { newPc.addTransceiver('video', { direction: 'recvonly' }); newPc.addTransceiver('audio', { direction: 'recvonly' }); } catch(e){}
      viewerPCs[streamerId] = newPc;
      // rewire handlers onto newPc
      newPc.ontrack = pc.ontrack;
      newPc.onicecandidate = pc.onicecandidate;
      newPc.oniceconnectionstatechange = pc.oniceconnectionstatechange;
      pc = newPc;
    }
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
  } catch (e) {
    console.error('Viewer: createOffer failed', e);
    logSignal('Viewer: createOffer failed: ' + (e && e.message));
    return;
  }
  // write offer under signals/{streamerId}/offers/{viewerId}
  console.log('Writing offer for', viewerId, 'to streamer', streamerId);
  await signalsRoot.child(`${streamerId}/offers/${viewerId}`).set({ sdp: pc.localDescription.sdp, author: auth.currentUser ? (auth.currentUser.email || auth.currentUser.uid) : 'anon' });
  logSignal(`Viewer: wrote offer ${viewerId} -> ${streamerId}`);
  console.log('Offer written for', viewerId);

  // listen for answer
  const answerRef = signalsRoot.child(`${streamerId}/answers/${viewerId}`);
  answerRef.on('value', async snap => {
    const v = snap.val(); if (!v || !v.sdp) return;
    try {
      await pc.setRemoteDescription({ type: 'answer', sdp: v.sdp });
  logSignal(`Viewer: received answer for ${viewerId}`);
  console.log('Received answer for viewer', viewerId);
    } catch (e) { console.error('Error setting remote desc (viewer)', e); }
  });

  // listen for answer ICE candidates
  const answerCandidatesRef = signalsRoot.child(`${streamerId}/answers/${viewerId}/candidates`);
  answerCandidatesRef.on('child_added', cSnap => {
    const c = cSnap.val(); if (c) pc.addIceCandidate(new RTCIceCandidate(c)).catch(e=>console.warn('addIceCandidate viewer', e));
  });

  // cleanup on stop: when streamer disappears child_removed will remove live item, but we also support manual stop
  const removeHandler = () => {
    try { pc.close(); } catch (e) {}
    try { answerRef.off(); answerCandidatesRef.off(); } catch (e) {}
    if (remoteVideo && remoteVideo.srcObject) {
      try { remoteVideo.srcObject.getTracks().forEach(t=>t.stop()); } catch(e){}
      remoteVideo.srcObject = null;
    }
    delete viewerPCs[streamerId];
  };
  // store for potential future cleanup
  viewerPCs[streamerId]._cleanup = removeHandler;
}

// Auth helpers
const userInfoEl = document.getElementById('user-info');
const authErrorEl = document.getElementById('auth-error');

function setAuthError(msg) {
  if (authErrorEl) authErrorEl.textContent = msg || '';
}

function updateUIForUser(user) {
  if (user) {
    if (signoutBtn) signoutBtn.hidden = false;
    if (signinBtn) signinBtn.hidden = true;
    if (signupBtn) signupBtn.hidden = true;
    if (userInfoEl) userInfoEl.textContent = `${user.displayName || user.email || user.uid}`;
  } else {
    if (signoutBtn) signoutBtn.hidden = true;
    if (signinBtn) signinBtn.hidden = false;
    if (signupBtn) signupBtn.hidden = false;
    if (userInfoEl) userInfoEl.textContent = '';
  }
}

// Prefer local persistence so user stays signed in between reloads
if (auth && firebase && firebase.auth && firebase.auth.Auth && firebase.auth.Auth.Persistence) {
  auth.setPersistence(firebase.auth.Auth.Persistence.LOCAL).catch(e => console.warn('Could not set persistence', e));
}

async function handleSignup() {
  const email = emailEl.value; const pw = passwordEl.value;
  if (!email || !pw) return setAuthError('Email and password are required');
  signupBtn.disabled = true; signinBtn.disabled = true; setAuthError('');
  try {
    const cred = await auth.createUserWithEmailAndPassword(email, pw);
    // clear password field after success
    passwordEl.value = '';
    console.log('Signup OK', cred.user && cred.user.uid);
  } catch (e) { console.error(e); setAuthError(e.message || 'Signup failed'); }
  signupBtn.disabled = false; signinBtn.disabled = false;
}

async function handleSignin() {
  const email = emailEl.value; const pw = passwordEl.value;
  if (!email || !pw) return setAuthError('Email and password are required');
  signupBtn.disabled = true; signinBtn.disabled = true; setAuthError('');
  try {
    const cred = await auth.signInWithEmailAndPassword(email, pw);
    passwordEl.value = '';
    console.log('Signin OK', cred.user && cred.user.uid);
  } catch (e) { console.error(e); setAuthError(e.message || 'Signin failed'); }
  signupBtn.disabled = false; signinBtn.disabled = false;
}

if (signupBtn) signupBtn.addEventListener('click', handleSignup);
if (signinBtn) signinBtn.addEventListener('click', handleSignin);
if (signoutBtn) signoutBtn.addEventListener('click', async () => { try { await auth.signOut(); } catch (e) { console.error('Signout error', e); setAuthError('Sign out failed'); } });

auth.onAuthStateChanged(user => {
  updateUIForUser(user);
  if (user) setAuthError('');
});

// Simple chat
sendMsgBtn.onclick = () => {
  const txt = messageInput.value.trim();
  if (!txt) return;
  const rid = roomId || PUBLIC_ROOM;
  if (!rid) return alert('Room unavailable');
  const user = auth.currentUser;
  const author = user ? (user.email || user.uid) : 'anon';
  const msgRef = db.ref(`rooms/${rid}/messages`).push();
  msgRef.set({ uid: user ? user.uid : null, author, text: txt, ts: Date.now() });
  messageInput.value = '';
};

function bindChat(rid) {
  messagesEl.innerHTML = '';
  const msgsRef = db.ref(`rooms/${rid}/messages`);
  msgsRef.on('child_added', snap => {
    const m = snap.val();
    const d = document.createElement('div');
    d.textContent = `[${new Date(m.ts).toLocaleTimeString()}] ${m.text}`;
    messagesEl.appendChild(d);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  });
}

// Room create
createRoomBtn && (createRoomBtn.onclick = () => {
  // No-op in public-room mode; keep for backward compatibility
  alert('Using public room. No creation necessary.');
});

copyRoomBtn && (copyRoomBtn.onclick = async () => {
  await navigator.clipboard.writeText(PUBLIC_ROOM);
});

// Start broadcast: capture camera and attach to local video
startBroadcastBtn.onclick = async () => {
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    localVideo.srcObject = localStream;
    startBroadcastBtn.disabled = true; stopBroadcastBtn.disabled = false;
  // log local audio track presence
  try { console.log('Local audio tracks:', localStream.getAudioTracks().map(t=>t.label || t.kind)); } catch(e){}
    // announce presence in public live list
    const user = auth.currentUser;
    const id = user ? user.uid : 'anon-' + Date.now();
    const label = user ? (user.email || user.uid) : 'Anonymous';
    try {
      await liveRef.child(id).set({ author: label, ts: Date.now() });
      liveRef.child(id).onDisconnect().remove();
      // store current live id so we can remove it on stop/unload
      window.__currentLiveId = id;
      presenceStatusEl.textContent = `Announced as live: ${label}`;
      console.log('Live presence set for', id);
  // start listening for incoming viewer offers
  startListeningForOffers(id);
    } catch (e) { console.error('Could not set live presence', e); presenceStatusEl.textContent = 'Presence announce failed'; }
  } catch (e) { console.error(e); alert('Unable to get camera: '+e.message); }
};
stopBroadcastBtn.onclick = () => {
  localStream && localStream.getTracks().forEach(t=>t.stop());
  localVideo.srcObject = null; localStream = null;
  startBroadcastBtn.disabled = false; stopBroadcastBtn.disabled = true;
  // remove presence
  const id = window.__currentLiveId || (auth.currentUser ? auth.currentUser.uid : null);
  if (id) {
    liveRef.child(id).remove().then(async () => {
      presenceStatusEl.textContent = 'Stopped broadcasting';
      console.log('Removed live presence for', id);
      window.__currentLiveId = null;
  // stop answering offers
  stopListeningForOffers(id);
      // remove signaling subtree (offers & answers)
      try { await signalsRoot.child(id).remove(); } catch (e) { console.warn('Failed to remove signaling subtree', e); }
    }).catch(e => { console.error('Failed to remove presence', e); presenceStatusEl.textContent = 'Failed to remove presence'; });
  }
};

// Ensure presence is removed if the tab/window unloads
window.addEventListener('beforeunload', () => {
  const id = window.__currentLiveId || (auth.currentUser ? auth.currentUser.uid : null);
  if (id) {
    try { liveRef.child(id).remove(); } catch (e) { console.warn('Could not remove presence on unload', e); }
  }
});

// Viewer join (stub): will implement offer/answer flow later
joinRoomBtn.onclick = async () => {
  // Viewing the public stream
  bindChat(PUBLIC_ROOM);
  roomId = PUBLIC_ROOM;
  alert('Bound to public room. Signaling not yet implemented.');
};

// Small feature: show stored firebase config hint if not replaced
if (firebaseConfig.apiKey === "YOUR_API_KEY") {
  console.warn('Replace firebaseConfig in app.js with your project config for full functionality.');
}

// Bind chat automatically to public room on load
bindChat(PUBLIC_ROOM);
