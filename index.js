const tmi = require('tmi.js');
const fetch = require('node-fetch').default;
const { createClient } = require('@supabase/supabase-js');

// Use environment variables (set these in Render dashboard)
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;

// Create Supabase client for realtime subscription
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// Track voters for current STORY voting phase (resets each voting phase)
let currentPhaseVoters = new Set();

// Track voters for REALM voting phase (max 3 votes per user)
let realmVotingMode = false;
let currentEpisodeNumber = 1;
let userRealmVotes = new Map(); // username → vote count (max 3)
let unavailableRealms = []; // realm names from previous episode

// Realm names in order (indices 0-24 map to !1-!25)
const REALM_NAMES = [
  'crystal_caverns',    // !1  - Fantasy
  'enchanted_forest',   // !2
  'floating_islands',   // !3
  'dragon_peaks',       // !4
  'underwater_ruins',   // !5
  'coral_depths',       // !6  - Nature
  'frozen_tundra',      // !7
  'volcanic_islands',   // !8
  'desert_dunes',       // !9
  'jungle_canopy',      // !10
  'neon_city',          // !11 - Urban
  'abandoned_mall',     // !12
  'subway_system',      // !13
  'rooftop_gardens',    // !14
  'carnival_grounds',   // !15
  'upside_down',        // !16 - Weird
  'dream_realm',        // !17
  'giant_library',      // !18
  'clock_tower',        // !19
  'toy_kingdom',        // !20
  'asteroid_belt',      // !21 - Cosmic
  'nebula_clouds',      // !22
  'moon_base',          // !23
  'black_hole_edge',    // !24
  'alien_jungle'        // !25
];

// Track current voting phase subscription channel (for cleanup)
let votingPhaseChannel = null;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 10;
const BASE_RECONNECT_DELAY = 2000; // 2 seconds

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

// Subscribe to voting events from Lovable system
// WITH proper channel cleanup to prevent "mismatch" errors
async function subscribeToVotingPhases() {
  // Clean up existing channel first to prevent duplicate subscriptions
  if (votingPhaseChannel) {
    console.log('🧹 Cleaning up old voting phase subscription...');
    try {
      await supabase.removeChannel(votingPhaseChannel);
    } catch (err) {
      console.log('⚠️ Error removing old channel:', err.message);
    }
    votingPhaseChannel = null;
  }

  console.log('📡 Subscribing to voting phase events...');
  
  // Use unique channel name to avoid conflicts
  const channelName = `voting_phases_${Date.now()}`;
  
  votingPhaseChannel = supabase
    .channel(channelName)
    .on(
      'postgres_changes',
      {
        event: 'INSERT',
        schema: 'public',
        table: 'events_queue'
      },
      (payload) => {
        const eventType = payload.new?.event_type;
        
        // REALM VOTING START - enable realm voting mode
        if (eventType === 'realm_voting_start') {
          console.log('🌍 REALM VOTING PHASE START detected!');
          realmVotingMode = true;
          userRealmVotes.clear();
          
          // Parse episode info and unavailable realms from message
          try {
            const data = JSON.parse(payload.new?.message || '{}');
            currentEpisodeNumber = data.episode || 1;
            unavailableRealms = data.previousRealms || [];
            console.log(`   Episode: ${currentEpisodeNumber}`);
            console.log(`   Unavailable realms: ${unavailableRealms.join(', ') || 'none (pilot episode)'}`);
          } catch (e) {
            console.log('   Could not parse realm voting data, using defaults');
          }
          
          console.log('✅ Realm voting mode ENABLED - accepting !1 through !25');
          reconnectAttempts = 0;
        }
        
        // REALM VOTING END - disable realm voting mode
        if (eventType === 'realm_voting_end') {
          console.log('🌍 REALM VOTING PHASE END detected!');
          console.log(`   Total realm voters: ${userRealmVotes.size}`);
          realmVotingMode = false;
          userRealmVotes.clear();
          console.log('✅ Realm voting mode DISABLED');
          reconnectAttempts = 0;
        }
        
        // STORY VOTING START - reset story voters (existing behavior)
        if (eventType === 'voting_phase_start') {
          console.log('🔔 STORY VOTING PHASE START detected!');
          console.log(`   Previous phase had ${currentPhaseVoters.size} unique voters`);
          
          // Also end realm voting if it was somehow still active
          if (realmVotingMode) {
            console.log('   (Also ending realm voting mode)');
            realmVotingMode = false;
            userRealmVotes.clear();
          }
          
          currentPhaseVoters.clear();
          console.log('✅ Story voter list cleared - ready for new voting phase!');
          reconnectAttempts = 0;
        }
      }
    )
    .subscribe((status, err) => {
      if (status === 'SUBSCRIBED') {
        console.log('✅ Successfully subscribed to voting phase events');
        reconnectAttempts = 0;
      } else if (status === 'CHANNEL_ERROR') {
        console.error('❌ Voting phase subscription error:', err);
        scheduleReconnect();
      } else if (status === 'CLOSED') {
        console.warn('⚠️ Voting phase subscription closed');
        scheduleReconnect();
      }
    });
    
  return votingPhaseChannel;
}

// Schedule a reconnection with exponential backoff
function scheduleReconnect() {
  if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    console.error('❌ Max reconnection attempts reached. Manual restart required.');
    return;
  }

  reconnectAttempts++;
  const delay = Math.min(BASE_RECONNECT_DELAY * Math.pow(2, reconnectAttempts - 1), 60000);
  console.log(`🔄 Reconnecting in ${delay / 1000}s (attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})...`);
  
  setTimeout(() => {
    subscribeToVotingPhases();
  }, delay);
}

// Connect with full error handling and retry
function connectWithRetry(attempts = 0) {
  client.connect()
    .then(() => {
      console.log('✅ CONNECTED TO iBLACKISH_ CHAT!');
      // Start listening for voting phase events from Lovable
      subscribeToVotingPhases();
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

  // REALM VOTING: !1 through !25 (only during realm voting phase)
  const realmVoteMatch = message.match(/^!(\d{1,2})$/);
  if (realmVotingMode && realmVoteMatch) {
    const voteNumber = parseInt(realmVoteMatch[1], 10);
    
    // Validate vote is in range 1-25
    if (voteNumber >= 1 && voteNumber <= 25) {
      const realmIndex = voteNumber - 1;
      const realmName = REALM_NAMES[realmIndex];
      
      // Check if this realm is unavailable (from previous episode)
      if (unavailableRealms.includes(realmName)) {
        console.log(`⚠️ Realm vote BLOCKED: ${realmName} is unavailable (recently visited)`);
        return;
      }
      
      // Check if user has already used all 3 realm votes
      const userVoteCount = userRealmVotes.get(username) || 0;
      if (userVoteCount >= 3) {
        console.log(`⚠️ Realm vote BLOCKED: ${username} already used 3 votes this phase`);
        return;
      }
      
      // Record the vote
      userRealmVotes.set(username, userVoteCount + 1);
      console.log(`🌍 Realm vote: !${voteNumber} (${realmName}) from ${username} (${userVoteCount + 1}/3 votes used)`);
      
      // Insert directly into realm_votes table
      sendRealmVote(realmName, username);
      return; // Don't process as story vote
    }
  }

  // STORY VOTING: !1 !2 !3 (only when NOT in realm voting mode, or if >3)
  if (!realmVotingMode && message.match(/^![123]$/)) {
    const choice = message[1];
    
    // Check if user already voted this phase
    if (currentPhaseVoters.has(username)) {
      console.log(`⚠️ Vote BLOCKED: ${username} already voted this phase`);
      return;
    }
    
    // Record this voter and process the vote
    currentPhaseVoters.add(username);
    console.log(`→ Vote detected: !${choice} from ${username} (${currentPhaseVoters.size} unique voters this phase)`);
    sendToSupabase('vote', username, 1, choice);
  }

  // Boss fight spam (!attack)
  if (message.toLowerCase() === '!attack') {
    console.log(`→ Attack detected from ${username}`);
    sendToSupabase('boss_attack', username, 1, '');
  }

  // Secret streamer commands (only you) - MANUAL BACKUP
  if (username.toLowerCase() === 'iblackish_') {
    if (message.startsWith('!ripple_start')) {
      currentPhaseVoters.clear();
      console.log(`→ 🔄 MANUAL VOTING PHASE RESET - Voter list cleared!`);
      console.log(`→ Secret start from iBlackish_`);
      sendToSupabase('secret_start', 'iblackish_', 1, message.slice(14).trim());
    }
    if (message === '!ripple_end') {
      console.log(`→ Secret end from iBlackish_ (${currentPhaseVoters.size} total voters this phase)`);
      sendToSupabase('secret_end', 'iblackish_', 1, '');
    }
    // Manual realm voting control
    if (message === '!realm_vote_start') {
      realmVotingMode = true;
      userRealmVotes.clear();
      unavailableRealms = [];
      console.log(`→ 🌍 MANUAL REALM VOTING START`);
    }
    if (message === '!realm_vote_end') {
      realmVotingMode = false;
      userRealmVotes.clear();
      console.log(`→ 🌍 MANUAL REALM VOTING END`);
    }
  }
});

// Send realm vote to realm_votes table
function sendRealmVote(realmName, username) {
  console.log(`→ Sending realm vote to Supabase: ${realmName} from ${username}`);
  
  fetch(`${SUPABASE_URL}/rest/v1/realm_votes`, {
    method: 'POST',
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=minimal'
    },
    body: JSON.stringify({
      season_number: 1,
      episode_number: currentEpisodeNumber,
      realm_name: realmName,
      user_name: username
    })
  })
  .then(res => {
    if (res.ok) {
      console.log('✅ SUCCESS → Realm vote inserted!');
    } else {
      console.error('❌ Supabase rejected realm vote →', res.status, res.statusText);
    }
  })
  .catch(err => console.error('❌ Realm vote fetch failed →', err));
}

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

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('🛑 Shutting down...');
  if (votingPhaseChannel) {
    await supabase.removeChannel(votingPhaseChannel);
  }
  await client.disconnect();
  process.exit(0);
});
