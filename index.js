// =============================================
// BTR Twitch Bot - Render Deployment
// =============================================

const tmi = require("tmi.js");
const { createClient } = require("@supabase/supabase-js");

// Environment variables (set in Render dashboard)
const TWITCH_USERNAME = process.env.TWITCH_USERNAME || "BTR_RippleBot";
const TWITCH_OAUTH = process.env.TWITCH_OAUTH;
const TWITCH_CHANNEL = process.env.TWITCH_CHANNEL || "iblackish";
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

// Validate required environment variables
if (!TWITCH_OAUTH) {
  console.error("ERROR: TWITCH_OAUTH is required");
  process.exit(1);
}
if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error("ERROR: SUPABASE_URL and SUPABASE_ANON_KEY are required");
  process.exit(1);
}

// Initialize Supabase client
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// Initialize Twitch client
const twitchClient = new tmi.Client({
  options: { debug: true },
  connection: {
    reconnect: true,
    secure: true,
  },
  identity: {
    username: TWITCH_USERNAME,
    password: TWITCH_OAUTH,
  },
  channels: [TWITCH_CHANNEL],
});

// =============================================
// State Management
// =============================================

// Track current phase for announcement logic
let currentPhase = "idle";
let currentEpisodePhase = "idle";
let votingTimeLeft = 0;
let realmVotingTimeLeft = 0;

// Vote tracking - one vote per user per voting phase
const userVotes = new Set();
const realmUserVotes = new Map(); // user -> array of voted realms (max 3)

// Bits tracking for enhancement announcements
let phaseBitsTotal = 0;
let lastAnnouncedTier = 0;

// Dynamic enhancement tiers (updated from events_queue)
let currentEnhancementTiers = [
  { id: 1, name: "Mystic Shield", bitsRequired: 250 },
  { id: 2, name: "Power Surge", bitsRequired: 500 },
  { id: 3, name: "Divine Blessing", bitsRequired: 750 },
];

// Duplicate message prevention
let lastBotMessage = "";
let lastBotMessageTime = 0;
const DUPLICATE_COOLDOWN_MS = 3000;

// =============================================
// Helper Functions
// =============================================

function saySafe(channel, message) {
  const now = Date.now();
  if (message === lastBotMessage && now - lastBotMessageTime < DUPLICATE_COOLDOWN_MS) {
    console.log(`[Bot] Blocked duplicate message: "${message.substring(0, 50)}..."`);
    return;
  }
  lastBotMessage = message;
  lastBotMessageTime = now;
  twitchClient.say(channel, message);
}

function resetVotingState() {
  userVotes.clear();
  phaseBitsTotal = 0;
  lastAnnouncedTier = 0;
}

function resetRealmVotingState() {
  realmUserVotes.clear();
}

// =============================================
// Twitch Event Handlers
// =============================================

twitchClient.on("message", async (channel, tags, message, self) => {
  if (self) return;

  const username = tags["display-name"] || tags.username;
  const msg = message.toLowerCase().trim();

  // Handle story choice votes (!1, !2, !3)
  if ((currentPhase === "voting" || currentPhase === "buffering") && /^![1-3]$/.test(msg)) {
    const choice = parseInt(msg.substring(1), 10);

    if (userVotes.has(username)) {
      // User already voted - ignore silently
      return;
    }

    userVotes.add(username);
    console.log(`[Vote] ${username} voted for choice ${choice}`);

    // Insert vote into events_queue
    await supabase.from("events_queue").insert({
      event_type: "vote",
      user_name: username,
      message: String(choice),
    });
  }

  // Handle realm votes (!realm_name during realm_voting phase)
  if (currentEpisodePhase === "realm_voting" && msg.startsWith("!")) {
    const realmName = msg.substring(1).replace(/_/g, " ");
    const userRealmVotes = realmUserVotes.get(username) || [];

    if (userRealmVotes.length >= 3) {
      // User already used all 3 votes
      return;
    }

    if (userRealmVotes.includes(realmName)) {
      // Already voted for this realm
      return;
    }

    userRealmVotes.push(realmName);
    realmUserVotes.set(username, userRealmVotes);
    console.log(`[Realm Vote] ${username} voted for ${realmName} (${userRealmVotes.length}/3 votes used)`);

    // Insert realm vote
    const { error } = await supabase.from("realm_votes").insert({
      realm_name: realmName,
      user_name: username,
      episode_number: 1,
      season_number: 1,
    });

    if (error) {
      console.error("[Realm Vote] Error inserting:", error.message);
    }
  }

  // Handle join command (!join during voting)
  if (currentPhase === "voting" && msg === "!join") {
    await supabase.from("events_queue").insert({
      event_type: "join",
      user_name: username,
    });
    console.log(`[Join] ${username} requested to join`);
  }
});

// Handle bits
twitchClient.on("cheer", async (channel, userstate, message) => {
  const bits = parseInt(userstate.bits, 10);
  const username = userstate["display-name"] || userstate.username;

  console.log(`[Bits] ${username} cheered ${bits} bits`);

  // Insert bits event
  await supabase.from("events_queue").insert({
    event_type: "bits",
    user_name: username,
    amount: bits,
    message: message || "",
  });

  // Track phase bits for enhancement announcements
  if (currentPhase === "voting" || currentPhase === "buffering") {
    phaseBitsTotal += bits;
    checkEnhancementUnlock(channel);
  }
});

// Handle subs
twitchClient.on("subscription", async (channel, username, method, message, userstate) => {
  console.log(`[Sub] ${username} subscribed`);
  await supabase.from("events_queue").insert({
    event_type: "sub",
    user_name: username,
    amount: 1,
  });
});

twitchClient.on("resub", async (channel, username, months, message, userstate, methods) => {
  console.log(`[Resub] ${username} resubbed for ${months} months`);
  await supabase.from("events_queue").insert({
    event_type: "sub",
    user_name: username,
    amount: 1,
    message: `Resub for ${months} months`,
  });
});

twitchClient.on("subgift", async (channel, username, streakMonths, recipient, methods, userstate) => {
  console.log(`[Gift Sub] ${username} gifted a sub to ${recipient}`);
  await supabase.from("events_queue").insert({
    event_type: "giftsub",
    user_name: username,
    amount: 1,
    message: `Gift to ${recipient}`,
  });
});

// =============================================
// Enhancement Unlock Announcements
// =============================================

function checkEnhancementUnlock(channel) {
  for (const tier of currentEnhancementTiers) {
    if (phaseBitsTotal >= tier.bitsRequired && tier.id > lastAnnouncedTier) {
      lastAnnouncedTier = tier.id;
      saySafe(
        channel,
        `🎉 ENHANCEMENT UNLOCKED: ${tier.name}! The chat has contributed ${phaseBitsTotal} bits! rippleHype`
      );
      break;
    }
  }
}

// =============================================
// Supabase Realtime Subscription
// =============================================

let subscriptionChannel = null;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 10;

async function setupRealtimeSubscription() {
  // Clean up existing subscription
  if (subscriptionChannel) {
    console.log("[Realtime] Removing old channel before creating new one");
    await supabase.removeChannel(subscriptionChannel);
    subscriptionChannel = null;
  }

  const channelName = `sequencer_bot_${Date.now()}`;
  console.log(`[Realtime] Creating new channel: ${channelName}`);

  subscriptionChannel = supabase
    .channel(channelName)
    .on(
      "postgres_changes",
      {
        event: "*",
        schema: "public",
        table: "sequencer_state",
        filter: "session_id=eq.default",
      },
      (payload) => {
        const data = payload.new;
        if (data) {
          handleSequencerUpdate(data);
        }
      }
    )
    .on(
      "postgres_changes",
      {
        event: "INSERT",
        schema: "public",
        table: "events_queue",
      },
      (payload) => {
        const event = payload.new;
        if (event && event.event_type === "enhancements_generated") {
          handleEnhancementsGenerated(event);
        }
      }
    )
    .subscribe((status) => {
      console.log(`[Realtime] Subscription status: ${status}`);
      if (status === "SUBSCRIBED") {
        reconnectAttempts = 0;
        console.log("[Realtime] Successfully subscribed to sequencer_state and events_queue");
      } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
        handleReconnect();
      }
    });
}

function handleEnhancementsGenerated(event) {
  try {
    const enhancements = JSON.parse(event.message);
    if (Array.isArray(enhancements) && enhancements.length === 3) {
      currentEnhancementTiers = enhancements;
      console.log("[Bot] Updated dynamic enhancements:", enhancements.map((e) => e.name));
    }
  } catch (err) {
    console.error("[Bot] Failed to parse enhancements_generated event:", err);
  }
}

function handleReconnect() {
  if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    console.error("[Realtime] Max reconnect attempts reached. Giving up.");
    return;
  }

  reconnectAttempts++;
  const delay = Math.min(2000 * Math.pow(2, reconnectAttempts - 1), 32000);
  console.log(`[Realtime] Reconnecting in ${delay}ms (attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`);

  setTimeout(() => {
    setupRealtimeSubscription();
  }, delay);
}

function handleSequencerUpdate(data) {
  const newPhase = data.phase;
  const newEpisodePhase = data.episode_phase;
  const channel = `#${TWITCH_CHANNEL}`;

  // Handle phase transitions
  if (newPhase !== currentPhase) {
    console.log(`[Phase] ${currentPhase} -> ${newPhase}`);

    // Voting phase start
    if (newPhase === "voting" && currentPhase !== "voting") {
      resetVotingState();
      const choices = data.choices || data.pending_choices || [];
      if (choices.length >= 3) {
        saySafe(
          channel,
          `📊 VOTING TIME! Type !1, !2, or !3 to vote! | !1 ${choices[0]?.title || "Option 1"} | !2 ${choices[1]?.title || "Option 2"} | !3 ${choices[2]?.title || "Option 3"}`
        );
      }
    }

    // Choice reveal
    if (newPhase === "choice_reveal") {
      const winner = data.winning_choice;
      if (winner) {
        saySafe(channel, `🏆 THE CHAT HAS SPOKEN! "${winner.title}" wins! rippleHype`);
      }
    }

    currentPhase = newPhase;
  }

  // Handle episode phase transitions
  if (newEpisodePhase !== currentEpisodePhase) {
    console.log(`[Episode Phase] ${currentEpisodePhase} -> ${newEpisodePhase}`);

    // Realm voting start
    if (newEpisodePhase === "realm_voting") {
      resetRealmVotingState();
      saySafe(
        channel,
        `🌍 REALM VOTING! Vote for up to 3 realms with !realm_name (e.g., !abyssal_depths). You have 3 votes! rippleHype`
      );
    }

    // Episode starting
    if (newEpisodePhase === "title_sequence" && currentEpisodePhase !== "title_sequence") {
      saySafe(channel, `🎬 The episode is starting! Get ready for an adventure! rippleHype`);
    }

    currentEpisodePhase = newEpisodePhase;
  }

  // Update time tracking
  votingTimeLeft = data.voting_time_left || 0;
  realmVotingTimeLeft = data.realm_voting_time_left || 0;

  // Voting countdown warnings
  if (currentPhase === "voting") {
    if (votingTimeLeft === 30) {
      saySafe(channel, `⏰ 30 seconds left to vote! Type !1, !2, or !3`);
    } else if (votingTimeLeft === 10) {
      saySafe(channel, `⏰ FINAL 10 SECONDS! Vote now!`);
    }
  }
}

// =============================================
// Startup
// =============================================

async function start() {
  console.log("=============================================");
  console.log("BTR Twitch Bot Starting...");
  console.log(`Channel: ${TWITCH_CHANNEL}`);
  console.log("=============================================");

  try {
    // Connect to Twitch
    await twitchClient.connect();
    console.log("[Twitch] Connected successfully");

    // Setup Supabase realtime
    await setupRealtimeSubscription();

    // Initial state load
    const { data } = await supabase
      .from("sequencer_state")
      .select("phase, episode_phase")
      .eq("session_id", "default")
      .maybeSingle();

    if (data) {
      currentPhase = data.phase || "idle";
      currentEpisodePhase = data.episode_phase || "idle";
      console.log(`[Init] Current phase: ${currentPhase}, Episode phase: ${currentEpisodePhase}`);
    }

    console.log("[Bot] Ready and listening!");
  } catch (err) {
    console.error("[Startup] Error:", err);
    process.exit(1);
  }
}

// Graceful shutdown
process.on("SIGTERM", async () => {
  console.log("[Bot] Received SIGTERM, shutting down gracefully...");
  if (subscriptionChannel) {
    await supabase.removeChannel(subscriptionChannel);
  }
  await twitchClient.disconnect();
  process.exit(0);
});

start();
