const tmi = require('tmi.js');
const fetch = require('node-fetch').default;
const { createClient } = require('@supabase/supabase-js');

// ============================================
// ENVIRONMENT VARIABLES (set in Render dashboard)
// ============================================
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const TWITCH_CLIENT_ID = process.env.TWITCH_CLIENT_ID;
const TWITCH_CLIENT_SECRET = process.env.TWITCH_CLIENT_SECRET;
const TWITCH_REFRESH_TOKEN = process.env.TWITCH_REFRESH_TOKEN;
const TWITCH_CHANNEL = process.env.TWITCH_CHANNEL || 'iblackish_';
const TWITCH_BOT_USERNAME = process.env.TWITCH_BOT_USERNAME || 'iblackish_';
const TWITCH_BROADCASTER_ID = process.env.TWITCH_BROADCASTER_ID || '172537045';

// Create Supabase client for realtime subscription
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ============================================
// VOTING STATE TRACKING
// ============================================

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

// ============================================
// NARRATOR STATE TRACKING
// ============================================
let lastEpisodePhase = 'idle';
let lastSequencerPhase = 'idle';
let lastPhaseBitsTotal = 0;
let announcedEnhancements = new Set(); // Track which enhancement tiers we've announced
let currentBossName = '';
let currentAccessToken = null; // Store access token for Helix API calls

// Announcement queue for rate limiting
let announcementQueue = [];
let isProcessingQueue = false;
const ANNOUNCEMENT_DELAY_MS = 3500; // 3.5 seconds between announcements

// ============================================
// DYNAMIC ENHANCEMENT TIERS
// ============================================
// Default enhancement tiers (fallback if dynamic ones aren't available)
const DEFAULT_ENHANCEMENT_TIERS = [
  { id: 1, threshold: 250, name: 'Coral Shield', description: 'iBlackish now deflects minor corruption attacks!' },
  { id: 2, threshold: 500, name: 'Trident Shard', description: 'iBlackish can now channel ancient sea magic!' },
  { id: 3, threshold: 750, name: 'Ancient Blessing', description: 'iBlackish now has full protection from shadow!' }
];

// Current phase's dynamic enhancements (updated from events_queue)
let currentPhaseEnhancements = [...DEFAULT_ENHANCEMENT_TIERS];

// ============================================
// SUPABASE SUBSCRIPTION STATE
// ============================================
let votingPhaseChannel = null;
let sequencerStateChannel = null;
let bossCompanionsChannel = null;
let companionBattleChannel = null;
let battleStateChannel = null;

let isSubscribing = false; // Guard to prevent duplicate subscription attempts
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 10;
const BASE_RECONNECT_DELAY = 2000; // 2 seconds

// ============================================
// TWITCH CLIENT (initialized after token fetch)
// ============================================
let twitchClient = null;

// ============================================
// STARTUP VALIDATION
// ============================================
console.log('🚀 Be the Ripple IRC listener is starting...');
console.log(`📡 Using Supabase URL: ${SUPABASE_URL}`);
console.log(`📢 Narrator enabled with Broadcaster ID: ${TWITCH_BROADCASTER_ID}`);

if (!SUPABASE_KEY || !SUPABASE_URL) {
  console.error('❌ ERROR: Missing SUPABASE_KEY or SUPABASE_URL environment variables!');
}
if (!TWITCH_CLIENT_ID || !TWITCH_CLIENT_SECRET || !TWITCH_REFRESH_TOKEN) {
  console.error('❌ ERROR: Missing TWITCH_CLIENT_ID, TWITCH_CLIENT_SECRET, or TWITCH_REFRESH_TOKEN!');
}
if (!TWITCH_BROADCASTER_ID) {
  console.warn('⚠️ WARNING: Missing TWITCH_BROADCASTER_ID - announcements will fall back to regular chat');
}

// ============================================
// AUTOMATIC TOKEN REFRESH
// ============================================
async function getAccessToken() {
  console.log('🔑 Fetching fresh Twitch access token...');
  
  const response = await fetch('https://id.twitch.tv/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: TWITCH_REFRESH_TOKEN,
      client_id: TWITCH_CLIENT_ID,
      client_secret: TWITCH_CLIENT_SECRET,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Token refresh failed: ${response.status} - ${errorText}`);
  }

  const data = await response.json();
  currentAccessToken = data.access_token; // Store for Helix API calls
  console.log('✅ Access token retrieved successfully!');
  return data.access_token;
}

// ============================================
// ORANGE ANNOUNCEMENT SYSTEM
// ============================================
async function sendAnnouncement(message, color = 'orange') {
  // Add to queue for rate limiting
  announcementQueue.push({ message, color });
  processAnnouncementQueue();
}

async function processAnnouncementQueue() {
  if (isProcessingQueue || announcementQueue.length === 0) return;
  
  isProcessingQueue = true;
  
  while (announcementQueue.length > 0) {
    const { message, color } = announcementQueue.shift();
    await sendAnnouncementNow(message, color);
    
    // Wait between announcements to respect rate limits
    if (announcementQueue.length > 0) {
      await new Promise(resolve => setTimeout(resolve, ANNOUNCEMENT_DELAY_MS));
    }
  }
  
  isProcessingQueue = false;
}

async function sendAnnouncementNow(message, color = 'orange') {
  // Ensure we have a valid access token
  if (!currentAccessToken) {
    try {
      await getAccessToken();
    } catch (err) {
      console.error('❌ Failed to get access token for announcement:', err.message);
      fallbackToChat(message);
      return;
    }
  }

  try {
    const response = await fetch(
      `https://api.twitch.tv/helix/chat/announcements?broadcaster_id=${TWITCH_BROADCASTER_ID}&moderator_id=${TWITCH_BROADCASTER_ID}`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${currentAccessToken}`,
          'Client-Id': TWITCH_CLIENT_ID,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ message, color })
      }
    );
    
    if (response.status === 204) {
      console.log(`📢 ANNOUNCEMENT SENT: ${message}`);
    } else if (response.status === 401) {
      // Token expired, refresh and retry
      console.log('🔄 Token expired, refreshing...');
      await getAccessToken();
      return sendAnnouncementNow(message, color);
    } else {
      const errorText = await response.text();
      console.error(`❌ Announcement failed (${response.status}): ${errorText}`);
      fallbackToChat(message);
    }
  } catch (error) {
    console.error('❌ Announcement error:', error.message);
    fallbackToChat(message);
  }
}

function fallbackToChat(message) {
  if (twitchClient) {
    console.log(`💬 Fallback to regular chat: ${message}`);
    twitchClient.say(`#${TWITCH_CHANNEL}`, message);
  }
}

// ============================================
// TWITCH CONNECTION
// ============================================
async function connectTwitch() {
  try {
    const accessToken = await getAccessToken();

    twitchClient = new tmi.Client({
      options: { debug: true },
      connection: {
        reconnect: true,
        secure: true,
        server: 'irc-ws.chat.twitch.tv',
        port: 443
      },
      identity: {
        username: TWITCH_BOT_USERNAME,
        password: `oauth:${accessToken}`
      },
      channels: [`#${TWITCH_CHANNEL}`]
    });

    // Set up message handler
    twitchClient.on('message', handleMessage);

    // Handle disconnections
    twitchClient.on('disconnected', (reason) => {
      console.warn('⚠️ Twitch disconnected:', reason);
      setTimeout(connectTwitch, 5000);
    });

    await twitchClient.connect();
    console.log(`✅ CONNECTED TO ${TWITCH_CHANNEL} CHAT!`);
    
    // Start listening for voting phase events
    subscribeToVotingPhases();
    
    // Start listening for narrator events (sequencer state, battles, etc.)
    subscribeToNarratorEvents();
    
  } catch (err) {
    console.error('❌ Twitch connection failed:', err.message);
    console.log('🔄 Retrying in 10 seconds...');
    setTimeout(connectTwitch, 10000);
  }
}

// ============================================
// MESSAGE HANDLER
// ============================================
function handleMessage(channel, tags, message, self) {
  if (self) return;

  const username = tags.username;

  // Bits cheers
  if (tags.bits && tags.bits > 0) {
    const amount = parseInt(tags.bits, 10);
    console.log(`→ Bits detected: ${amount} from ${username}`);
    sendToSupabase('channel.cheer', username, amount, '');
    
    // Announce bits donation in chat
    sendAnnouncement(`✨ ${username} donated ${amount} bits! The Ripple grows stronger!`);
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

  // STORY VOTING: !1 !2 !3 (only when NOT in realm voting mode)
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
    // Manual narrator test
    if (message === '!test_announce') {
      sendAnnouncement('🧪 This is a test announcement from the BTR Narrator!');
    }
  }
}

// ============================================
// SUPABASE VOTING PHASE SUBSCRIPTION
// ============================================
async function subscribeToVotingPhases() {
  // Prevent duplicate subscription attempts
  if (isSubscribing) {
    console.log('⚠️ Already subscribing, skipping...');
    return;
  }
  isSubscribing = true;

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
        
        // DYNAMIC ENHANCEMENTS GENERATED - store for use in announcements
        if (eventType === 'enhancements_generated') {
          console.log('🎯 DYNAMIC ENHANCEMENTS RECEIVED!');
          try {
            const enhancements = JSON.parse(payload.new?.message || '[]');
            if (Array.isArray(enhancements) && enhancements.length === 3) {
              // Map to our expected format with thresholds
              currentPhaseEnhancements = enhancements.map((e, index) => ({
                id: e.id || index + 1,
                threshold: e.bitsRequired || [250, 500, 750][index],
                name: e.name,
                description: e.description || e.narrativeEffect || 'A powerful enhancement!'
              }));
              console.log('✅ Dynamic enhancements loaded:', currentPhaseEnhancements.map(e => e.name).join(', '));
            }
          } catch (err) {
            console.error('❌ Failed to parse dynamic enhancements:', err.message);
          }
        }
        
        // REALM VOTING START - enable realm voting mode
        if (eventType === 'realm_voting_start') {
          console.log('🌍 REALM VOTING PHASE START detected!');
          realmVotingMode = true;
          userRealmVotes.clear();
          
          // Reset enhancements to defaults for new episode
          currentPhaseEnhancements = [...DEFAULT_ENHANCEMENT_TIERS];
          
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
          
          // NARRATOR: Episode start announcement
          sendAnnouncement(`🎬 BTR: Becoming the Ripple is starting now! This is Season 1, Episode ${currentEpisodeNumber}!`);
          
          // NARRATOR: Realm voting instructions (delayed slightly)
          setTimeout(() => {
            sendAnnouncement("🌍 Now is the time to vote for tonight's 3 realms! Type !1 - !25 to vote; you can vote up to three times!");
          }, 5000);
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
          announcedEnhancements.clear(); // Reset enhancement announcements for new voting phase
          console.log('✅ Story voter list cleared - ready for new voting phase!');
          reconnectAttempts = 0;
          
          // NARRATOR: Voting phase announcement
          sendAnnouncement("🗳️ It's time to vote! Type !1, !2, or !3 to vote for an option. You can also contribute bits towards one of the enhancements on the left side of the screen! If any of the bit levels are reached, it will contribute directly to the story!");
        }
      }
    )
    .subscribe((status, err) => {
      isSubscribing = false; // Reset guard after subscription attempt completes
      
      if (status === 'SUBSCRIBED') {
        console.log('✅ Successfully subscribed to voting phase events');
        reconnectAttempts = 0;
      } else if (status === 'CHANNEL_ERROR') {
        console.error('❌ Voting phase subscription error:', err);
        scheduleReconnect();
      }
      // Note: We intentionally ignore 'CLOSED' status to prevent reconnect loops
    });
    
  return votingPhaseChannel;
}

// ============================================
// NARRATOR EVENT SUBSCRIPTIONS
// ============================================
async function subscribeToNarratorEvents() {
  console.log('📢 Setting up Narrator event subscriptions...');
  
  // Subscribe to sequencer_state for phase changes
  await subscribeToSequencerState();
  
  // Subscribe to boss_companions for new companion announcements
  await subscribeToBossCompanions();
  
  // Subscribe to companion_battle_state for death announcements
  await subscribeToCompanionBattleState();
  
  // Subscribe to battle_state for battle outcome announcements
  await subscribeToBattleState();
}

async function subscribeToSequencerState() {
  if (sequencerStateChannel) {
    try {
      await supabase.removeChannel(sequencerStateChannel);
    } catch (err) {
      console.log('⚠️ Error removing old sequencer channel:', err.message);
    }
  }
  
  const channelName = `sequencer_narrator_${Date.now()}`;
  
  sequencerStateChannel = supabase
    .channel(channelName)
    .on(
      'postgres_changes',
      {
        event: 'UPDATE',
        schema: 'public',
        table: 'sequencer_state'
      },
      (payload) => {
        const newState = payload.new;
        const oldState = payload.old;
        
        const newEpisodePhase = newState?.episode_phase;
        const newPhase = newState?.phase;
        const phaseBitsTotal = newState?.phase_bits_total || 0;
        const episodeNumber = newState?.episode_number || 1;
        
        // Update current episode number
        currentEpisodeNumber = episodeNumber;
        
        // Track boss name for battle outcome messages
        if (newState?.current_realm) {
          // We'll get the actual boss name from battle_state
        }
        
        // EPISODE PHASE CHANGES
        if (newEpisodePhase !== lastEpisodePhase) {
          console.log(`📢 Episode phase changed: ${lastEpisodePhase} → ${newEpisodePhase}`);
          
          // Recap (episodes 2+)
          if (newEpisodePhase === 'recap' && episodeNumber > 1) {
            sendAnnouncement("📜 Last week on BTR: Becoming the Ripple...");
          }
          
          // How-to-Play
          if (newEpisodePhase === 'how_to_play') {
            sendAnnouncement("📖 These are instructions on how to play/choose the adventure!");
          }
          
          // Pre-Battle
          if (newEpisodePhase === 'pre_battle') {
            sendAnnouncement("⚔️ A boss battle is about to begin! iBlackish has gathered his companions to determine the fate of the realm!");
            
            // Staggered second message about healing
            setTimeout(() => {
              sendAnnouncement("💖 Viewers can heal companions with bits! 100 bits heals 5% of up to 5 companions! Gift subs resurrect fallen companions!");
            }, 5000);
          }
          
          // Outro
          if (newEpisodePhase === 'outro') {
            sendAnnouncement("🌟 Thank you for watching BTR: Becoming the Ripple! Join us next week as we continue the adventure! Which realms will we tackle next week?! Tune in to find out!");
          }
          
          lastEpisodePhase = newEpisodePhase;
        }
        
        // SEQUENCER PHASE CHANGES (playing_leadin, playing_segment)
        if (newPhase !== lastSequencerPhase) {
          console.log(`📢 Sequencer phase changed: ${lastSequencerPhase} → ${newPhase}`);
          
          // Lead-in (choice being implemented)
          if (newPhase === 'playing_leadin') {
            sendAnnouncement("✍️ Chat's decision is being written into the story. Let's see where it goes!");
          }
          
          // New segment after lead-in
          if (newPhase === 'playing_segment' && lastSequencerPhase === 'playing_leadin') {
            sendAnnouncement("🎭 Chat's decision has been implemented! Watch this!");
          }
          
          lastSequencerPhase = newPhase;
        }
        
        // ENHANCEMENT TIER ANNOUNCEMENTS (using dynamic tier names)
        if (phaseBitsTotal > lastPhaseBitsTotal) {
          for (const tier of currentPhaseEnhancements) {
            if (phaseBitsTotal >= tier.threshold && !announcedEnhancements.has(tier.threshold)) {
              announcedEnhancements.add(tier.threshold);
              sendAnnouncement(`🎉 ENHANCEMENT UNLOCKED: ${tier.name}! Chat has contributed ${tier.threshold} bits! ${tier.description}`);
            }
          }
        }
        lastPhaseBitsTotal = phaseBitsTotal;
        
        // Reset enhancement tracking when bits reset (new voting phase)
        if (phaseBitsTotal === 0 && lastPhaseBitsTotal > 0) {
          announcedEnhancements.clear();
        }
      }
    )
    .subscribe((status, err) => {
      if (status === 'SUBSCRIBED') {
        console.log('✅ Subscribed to sequencer_state for narrator');
      } else if (status === 'CHANNEL_ERROR') {
        console.error('❌ Sequencer state subscription error:', err);
      }
    });
}

async function subscribeToBossCompanions() {
  if (bossCompanionsChannel) {
    try {
      await supabase.removeChannel(bossCompanionsChannel);
    } catch (err) {
      console.log('⚠️ Error removing old companions channel:', err.message);
    }
  }
  
  const channelName = `companions_narrator_${Date.now()}`;
  
  bossCompanionsChannel = supabase
    .channel(channelName)
    .on(
      'postgres_changes',
      {
        event: 'INSERT',
        schema: 'public',
        table: 'boss_companions'
      },
      (payload) => {
        const companion = payload.new;
        const companionName = companion?.companion_name || companion?.username;
        if (companionName) {
          console.log(`📢 New companion joined: ${companionName}`);
          sendAnnouncement(`⚔️ ${companionName} has joined the battle to fight alongside iBlackish!`);
        }
      }
    )
    .subscribe((status, err) => {
      if (status === 'SUBSCRIBED') {
        console.log('✅ Subscribed to boss_companions for narrator');
      } else if (status === 'CHANNEL_ERROR') {
        console.error('❌ Boss companions subscription error:', err);
      }
    });
}

async function subscribeToCompanionBattleState() {
  if (companionBattleChannel) {
    try {
      await supabase.removeChannel(companionBattleChannel);
    } catch (err) {
      console.log('⚠️ Error removing old battle state channel:', err.message);
    }
  }
  
  const channelName = `companion_deaths_narrator_${Date.now()}`;
  
  companionBattleChannel = supabase
    .channel(channelName)
    .on(
      'postgres_changes',
      {
        event: 'UPDATE',
        schema: 'public',
        table: 'companion_battle_state'
      },
      (payload) => {
        const wasAlive = payload.old?.is_alive;
        const isAlive = payload.new?.is_alive;
        const username = payload.new?.username;
        
        // Companion just died
        if (wasAlive === true && isAlive === false && username) {
          console.log(`📢 Companion slain: ${username}`);
          sendAnnouncement(`💀 ${username} has been slain! May they not be forgotten. (Remember: chat can resurrect fallen companions by gifting a sub!)`);
        }
      }
    )
    .subscribe((status, err) => {
      if (status === 'SUBSCRIBED') {
        console.log('✅ Subscribed to companion_battle_state for narrator');
      } else if (status === 'CHANNEL_ERROR') {
        console.error('❌ Companion battle state subscription error:', err);
      }
    });
}

async function subscribeToBattleState() {
  if (battleStateChannel) {
    try {
      await supabase.removeChannel(battleStateChannel);
    } catch (err) {
      console.log('⚠️ Error removing old battle outcome channel:', err.message);
    }
  }
  
  const channelName = `battle_outcome_narrator_${Date.now()}`;
  
  battleStateChannel = supabase
    .channel(channelName)
    .on(
      'postgres_changes',
      {
        event: 'UPDATE',
        schema: 'public',
        table: 'battle_state'
      },
      (payload) => {
        const wasActive = payload.old?.is_active;
        const isActive = payload.new?.is_active;
        const bossName = payload.new?.boss_name || 'The Boss';
        const bossHealth = payload.new?.boss_health || 0;
        const ibHealth = payload.new?.ib_health || 0;
        
        // Track current boss name
        if (bossName) {
          currentBossName = bossName;
        }
        
        // Battle just ended
        if (wasActive === true && isActive === false) {
          console.log(`📢 Battle ended! Boss HP: ${bossHealth}, IB HP: ${ibHealth}`);
          
          // Determine winner based on health
          // Victory if boss is at 0 health, defeat if IB is at 0 health
          if (bossHealth <= 0) {
            // Victory!
            sendAnnouncement(`🏆 VICTORY! The boss has been defeated! The realm is saved!`);
          } else if (ibHealth <= 0) {
            // Defeat
            sendAnnouncement(`💀 DEFEAT... The darkness consumes all. But the story continues...`);
          } else {
            // Battle ended for other reasons (timeout?)
            sendAnnouncement(`⚔️ The battle has concluded! The fate of this realm hangs in the balance...`);
          }
        }
      }
    )
    .subscribe((status, err) => {
      if (status === 'SUBSCRIBED') {
        console.log('✅ Subscribed to battle_state for narrator');
      } else if (status === 'CHANNEL_ERROR') {
        console.error('❌ Battle state subscription error:', err);
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

// ============================================
// SUPABASE DATA FUNCTIONS
// ============================================

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

// ============================================
// GRACEFUL SHUTDOWN
// ============================================
process.on('SIGTERM', async () => {
  console.log('🛑 Shutting down...');
  
  // Clean up all channels
  const channels = [votingPhaseChannel, sequencerStateChannel, bossCompanionsChannel, companionBattleChannel, battleStateChannel];
  for (const channel of channels) {
    if (channel) {
      try {
        await supabase.removeChannel(channel);
      } catch (err) {
        console.log('⚠️ Error removing channel during shutdown:', err.message);
      }
    }
  }
  
  if (twitchClient) {
    await twitchClient.disconnect();
  }
  process.exit(0);
});

// ============================================
// START THE BOT
// ============================================
connectTwitch();
