const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_DB_PATH = path.join(__dirname, 'reinhard-bot.db.json');
const DB_PATH = process.env.BOT_DB_PATH || DEFAULT_DB_PATH;

function defaultState() {
  return {
    settings: {
      recruitmentOpen: true
    },
    applications: [],
    events: []
  };
}

function readState() {
  try {
    const raw = fs.readFileSync(DB_PATH, 'utf8');
    const state = JSON.parse(raw);
    return {
      ...defaultState(),
      ...state,
      settings: { ...defaultState().settings, ...(state.settings || {}) },
      applications: Array.isArray(state.applications) ? state.applications : [],
      events: Array.isArray(state.events) ? state.events : []
    };
  } catch {
    return defaultState();
  }
}

function writeState(state) {
  const dir = path.dirname(DB_PATH);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(DB_PATH, JSON.stringify(state, null, 2), 'utf8');
}

function updateState(mutator) {
  const state = readState();
  const result = mutator(state);
  writeState(state);
  return result === undefined ? state : result;
}

function makeId(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function addEvent(state, event) {
  state.events.unshift({
    id: makeId('event'),
    at: new Date().toISOString(),
    ...event
  });
  state.events = state.events.slice(0, 2000);
}

module.exports = {
  DB_PATH,
  readState,
  writeState,
  updateState,
  makeId,
  addEvent
};
