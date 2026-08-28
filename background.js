// Background Service Worker for Spotify Lyrics Extension.
// Owns Discord status updates so they continue after the popup closes.

importScripts('discord.js');

const ACTIONS = {
  TRACK_CHANGED: 'trackChanged',
  LYRIC_CHANGED: 'currentLyricChanged',
  PLAYBACK_CHANGED: 'playbackChanged'
};

const MUSIC_NOTE_TEXT = '\u266a';
const STATUS_PREFIX = MUSIC_NOTE_TEXT;
const DISCORD_UPDATE_COOLDOWN_MS = 800;

const discordState = {
  appliedStatus: undefined,
  pendingStatus: '',
  lastUpdateAt: 0,
  updateTimerId: null,
  inFlightUpdate: null,
  forceNextLyricUpdate: true
};

chrome.runtime.onMessage.addListener((message) => {
  switch (message.action) {
    case ACTIONS.TRACK_CHANGED:
      console.log('Track changed:', message.track);
      discordState.forceNextLyricUpdate = true;
      break;

    case ACTIONS.LYRIC_CHANGED:
      handleLyricChanged(message);
      break;

    case ACTIONS.PLAYBACK_CHANGED:
      if (!message.playing) {
        clearDiscordStatus();
      }
      break;

    default:
      break;
  }
});

function handleLyricChanged(message) {
  const cleanLyric = normalizeText(message.lyric);

  if (message.lyrics) {
    saveLatestLyrics(message.lyrics);
  }

  if (cleanLyric) {
    saveCurrentLyric(cleanLyric);
  }

  if (!cleanLyric) {
    return;
  }

  scheduleDiscordStatusUpdate(formatDiscordStatus(cleanLyric), discordState.forceNextLyricUpdate);
}

function formatDiscordStatus(lyric) {
  return lyric === MUSIC_NOTE_TEXT
    ? MUSIC_NOTE_TEXT
    : `${STATUS_PREFIX} ${lyric}`;
}

function scheduleDiscordStatusUpdate(statusText, forceImmediate = false) {
  const cleanStatus = normalizeText(statusText);

  if (!cleanStatus || cleanStatus === discordState.appliedStatus) {
    return;
  }

  discordState.pendingStatus = cleanStatus;
  clearScheduledDiscordUpdate();

  const elapsed = Date.now() - discordState.lastUpdateAt;
  const delay = forceImmediate ? 0 : Math.max(DISCORD_UPDATE_COOLDOWN_MS - elapsed, 0);

  discordState.updateTimerId = setTimeout(applyPendingDiscordStatus, delay);
}

async function applyPendingDiscordStatus() {
  discordState.updateTimerId = null;

  const status = discordState.pendingStatus;

  if (!status || status === discordState.appliedStatus) {
    return;
  }

  try {
    const credentials = await getDiscordCredentials();

    if (!credentials) {
      return;
    }

    const updatePromise = updateDiscordStatus(credentials.token, status);
    discordState.inFlightUpdate = updatePromise;
    let updated;
    try {
      updated = await updatePromise;
    } finally {
      if (discordState.inFlightUpdate === updatePromise) {
        discordState.inFlightUpdate = null;
      }
    }

    if (updated) {
      discordState.appliedStatus = status;
      discordState.lastUpdateAt = Date.now();
      discordState.forceNextLyricUpdate = false;
    }
  } catch (error) {
    console.error('Error updating Discord status in background:', error);
  }
}

async function clearDiscordStatus() {
  clearScheduledDiscordUpdate();

  if (!discordState.appliedStatus && !discordState.pendingStatus) {
    return;
  }

  if (discordState.inFlightUpdate) {
    try {
      await discordState.inFlightUpdate;
    } catch (error) {
      console.error('Error waiting for Discord status update:', error);
    }
  }

  discordState.pendingStatus = '';

  try {
    const credentials = await getDiscordCredentials();

    if (!credentials) {
      return;
    }

    const cleared = await updateDiscordStatus(credentials.token, '');

    if (cleared) {
      discordState.appliedStatus = '';
      discordState.pendingStatus = '';
      discordState.forceNextLyricUpdate = true;
    }
  } catch (error) {
    console.error('Error clearing Discord status in background:', error);
  }
}

async function getDiscordCredentials() {
  const [autoUpdate, token] = await Promise.all([
    getDiscordAutoUpdate(),
    getDiscordToken()
  ]);

  if (!autoUpdate || !token) {
    return null;
  }

  return { token };
}

function clearScheduledDiscordUpdate() {
  if (!discordState.updateTimerId) {
    return;
  }

  clearTimeout(discordState.updateTimerId);
  discordState.updateTimerId = null;
}

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}
