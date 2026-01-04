const tmi = require('tmi.js');
const fetch = require('node-fetch').default;

// Use environment variables (set these in Render dashboard)
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;

// Track voters for current phase (resets each voting phase)
let currentPhaseVoters = new Set();

const client = new tmi.Client({
  options: { debug: true },
  connection: {
    reconnect: true,
    secure: true,
    server: 'irc-ws.chat.twitch.tv',
    port: 443
  },
  identity: {
    username: 'iblackish_',
    password: 'oauth:224pzci41bk1jw6qy2d2icsrvbikx1'
  },
  channels: ['#iblackish_']
});

// Startup validation
console.log('🚀 Be the Ripple IRC listener is starting...');
console.log(`📡 Using Supabase URL: ${SUPABASE_URL}`);

if (!SUPABASE_KEY || !SUPABASE_URL) {
  console.error('❌ ERROR: Missing SUPABASE_KEY or SUPABASE_URL environment variables!');
}

// Connect with full error handling and retry
function connectWithRetry(attempts = 0) {
  client.connect()
    .then(() => {
      console.log('✅ CONNECTED TO iBLACKISH_ CHAT!');
    })
    .catch((err) => {
      console.error(`❌ Connection attempt ${attempts + 1} failed:`, err.message);
      console.error('Full error:', err);
      if (attempts < 3) {
        console.log('Retrying in 5 seconds...');
        setTimeout(() => connectWithRetry(attempts + 1), 5000);
      } else {
        console.error('Max retries reached. Check token or network.');
      }
    });
}

connectWithRetry();

client.on('message', (channel, tags, message, self) => {
  if (self) return;

  const username = tags.username;

  // Bits cheers
  if (tags.bits && tags.bits > 0) {
    console.log(`→ Bits detected: ${tags.bits} from ${username}`);
    sendToSupabase('channel.cheer', username, tags.bits, '');
  }

  // New sub / resub
  if (tags['msg-id'] === 'sub' || tags['msg-id'] === 'resub') {
    console.log(`→ Sub detected: ${tags['msg-id']} from ${username}`);
    sendToSupabase('channel.subscribe', username, 1, '');
  }

  // Gifted subs
  if (tags['msg-id'] === 'subgift' || tags['msg-id'] === 'anonsubgift') {
    console.log(`→ Gift sub detected: ${tags['msg-id']} from ${username}`);
    sendToSupabase('channel.subscription.gift', username, 1, '');
  }

  // Sub-only votes (!1 !2 !3) - ONE VOTE PER USER PER PHASE
  if (message.match(/^![123]$/) && (tags.subscriber === true || tags.subscriber === '1')) {
    const choice = message[1];
    
    // Check if user already voted this phase
    if (currentPhaseVoters.has(username)) {
      console.log(`⚠️ Vote BLOCKED: ${username} already voted this phase`);
      return; // Don't process duplicate vote
    }
    
    // Record this voter and process the vote
    currentPhaseVoters.add(username);
    console.log(`→ Vote detected: !${choice} from sub ${username} (${currentPhaseVoters.size} unique voters this phase)`);
    sendToSupabase('vote', username, 1, choice);
  }

  // Boss fight spam (!attack)
  if (message.toLowerCase() === '!attack') {
    console.log(`→ Attack detected from ${username}`);
    sendToSupabase('boss_attack', username, 1, '');
  }

  // Secret streamer commands (only you)
  if (username.toLowerCase() === 'iblackish_') {
    if (message.startsWith('!ripple_start')) {
      // RESET VOTERS FOR NEW PHASE
      currentPhaseVoters.clear();
      console.log(`→ 🔄 NEW VOTING PHASE STARTED - Voter list cleared!`);
      console.log(`→ Secret start from iBlackish_`);
      sendToSupabase('secret_start', 'iblackish_', 1, message.slice(14).trim());
    }

    if (message === '!ripple_end') {
      console.log(`→ Secret end from iBlackish_ (${currentPhaseVoters.size} total voters this phase)`);
      sendToSupabase('secret_end', 'iblackish_', 1, '');
    }
  }
});

function sendToSupabase(type, user, amount, msg) {
  console.log(`→ Sending to Supabase: ${type} | ${user} | amount:${amount} | "${msg}"`);
  
  fetch(`${SUPABASE_URL}/rest/v1/events_queue`, {
    method: 'POST',
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=minimal'
    },
    body: JSON.stringify({ event_type: type, user_name: user, amount, message: msg })
  })
  .then(res => {
    if (res.ok) {
      console.log('✅ SUCCESS → Row inserted in Supabase!');
    } else {
      console.error('❌ Supabase rejected →', res.status, res.statusText);
    }
  })
  .catch(err => console.error('❌ Fetch failed →', err));
}
