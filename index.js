import tmi from 'tmi.js';
import { createClient } from '@supabase/supabase-js';

// Environment variables
const TWITCH_BOT_USERNAME = process.env.TWITCH_BOT_USERNAME;
const TWITCH_OAUTH_TOKEN = process.env.TWITCH_OAUTH_TOKEN;
const TWITCH_CHANNEL = process.env.TWITCH_CHANNEL;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

// Initialize Supabase client
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// Track voters per phase to enforce one-vote-per-user
const currentPhaseVoters = new Set();

// Track current voting phase subscription channel
let votingPhaseChannel = null;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 10;
const BASE_RECONNECT_DELAY = 2000; // 2 seconds

// Initialize Twitch client
const client = new tmi.Client({
  options: { debug: false },
  identity: {
    username: TWITCH_BOT_USERNAME,
    password: TWITCH_OAUTH_TOKEN
  },
  channels: [TWITCH_CHANNEL]
});

// Subscribe to voting phase events from Supabase
async function subscribeToVotingPhases() {
  // Clean up existing channel first
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
        table: 'events_queue',
        filter: 'event_type=eq.voting_phase_start'
      },
      (payload) => {
        console.log('🗳️ Voting phase started! Clearing voter list.');
        currentPhaseVoters.clear();
        reconnectAttempts = 0; // Reset on successful message
      }
    )
    .subscribe((status, err) => {
      if (status === 'SUBSCRIBED') {
        console.log('✅ Successfully subscribed to voting phase events');
        reconnectAttempts = 0; // Reset on successful subscription
      } else if (status === 'CHANNEL_ERROR') {
        console.error('❌ Voting phase subscription error:', err);
        scheduleReconnect();
      } else if (status === 'CLOSED') {
        console.log('⚠️ Voting phase subscription closed');
        scheduleReconnect();
      }
    });
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

// Handle chat messages
client.on('message', async (channel, tags, message, self) => {
  if (self) return;

  const username = tags['display-name'] || tags.username;
  const isBroadcaster = tags.badges?.broadcaster === '1';
  const isMod = tags.mod;
  const isSubscriber = tags.subscriber;
  const bits = parseInt(tags.bits) || 0;

  // Handle bits (cheers)
  if (bits > 0) {
    await supabase.from('events_queue').insert({
      event_type: 'channel.cheer',
      user_name: username,
      amount: bits,
      message: message
    });
    console.log(`💎 ${username} cheered ${bits} bits`);
  }

  // Handle votes (!1, !2, !3) - ALL viewers can vote, one per phase
  if (['!1', '!2', '!3'].includes(message.trim())) {
    // Check if user already voted this phase
    if (currentPhaseVoters.has(username.toLowerCase())) {
      console.log(`🚫 ${username} already voted this phase`);
      return;
    }

    const voteNumber = message.trim().charAt(1);
    await supabase.from('events_queue').insert({
      event_type: 'vote',
      user_name: username,
      amount: 1,
      message: voteNumber
    });
    
    // Mark user as voted for this phase
    currentPhaseVoters.add(username.toLowerCase());
    console.log(`🗳️ ${username} voted for option ${voteNumber}`);
  }

  // Handle attack command during boss battles
  if (message.trim().toLowerCase() === '!attack') {
    // Could add companion roster check here if needed
    console.log(`⚔️ ${username} used !attack`);
    // Attack handling is done via the battle-actions edge function
  }
});

// Handle subscriptions
client.on('subscription', async (channel, username, method, message, userstate) => {
  await supabase.from('events_queue').insert({
    event_type: 'channel.subscribe',
    user_name: username,
    amount: 1,
    message: message || ''
  });
  console.log(`⭐ ${username} subscribed!`);
});

// Handle gift subs
client.on('submysterygift', async (channel, username, numbOfSubs, methods, userstate) => {
  await supabase.from('events_queue').insert({
    event_type: 'channel.subscription.gift',
    user_name: username,
    amount: numbOfSubs,
    message: `Gifted ${numbOfSubs} subs`
  });
  console.log(`🎁 ${username} gifted ${numbOfSubs} subs!`);
});

// Handle resubs
client.on('resub', async (channel, username, months, message, userstate, methods) => {
  await supabase.from('events_queue').insert({
    event_type: 'channel.subscribe',
    user_name: username,
    amount: 1,
    message: message || `Resubbed for ${months} months`
  });
  console.log(`⭐ ${username} resubscribed for ${months} months!`);
});

// Connect to Twitch
client.connect()
  .then(() => {
    console.log(`✅ CONNECTED TO ${TWITCH_CHANNEL.toUpperCase()} CHAT!`);
    // Start voting phase subscription after Twitch connection
    subscribeToVotingPhases();
  })
  .catch(err => {
    console.error('Failed to connect to Twitch:', err);
  });

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('🛑 Shutting down...');
  if (votingPhaseChannel) {
    await supabase.removeChannel(votingPhaseChannel);
  }
  await client.disconnect();
  process.exit(0);
});
