// v2 §6A the `en` catalog: one JSON per namespace, merged into flat `<ns>.<path>` keys (translated from vi).
// The web loads it only when the UI switches to English (spec v2.1 §5.6 bundle); the engine always.
// How to add a key / namespace: docs/ref/i18n.md.
import { addCatalog } from './core.ts';
import accounts from './en/accounts.json';
import common from './en/common.json';
import settings from './en/settings.json';
import topbar from './en/topbar.json';
import wizard from './en/wizard.json';
import format from './en/format.json';
import roles from './en/roles.json';
import unit from './en/unit.json';
import list from './en/list.json';
import inbox from './en/inbox.json';
import console from './en/console.json';
import palette from './en/palette.json';
import addProject from './en/addProject.json';
import subagent from './en/subagent.json';
import inspector from './en/inspector.json';
import screens from './en/screens.json';
import app from './en/app.json';
import cards from './en/cards.json';
import errors from './en/errors.json';
import notify from './en/notify.json';
import labels from './en/labels.json';
import deck from './en/deck.json';
import cardText from './en/cardText.json';
import tauri from './en/tauri.json';
import config from './en/config.json';
import menu from './en/menu.json';
import session from './en/session.json';
import done from './en/done.json';
import stream from './en/stream.json';
import model from './en/model.json';
import attach from './en/attach.json';
import tasks from './en/tasks.json';
import update from './en/update.json';

/** namespace → its `en` strings. */
export const EN_NS = { accounts, common, settings, topbar, wizard, format, roles, unit, list, inbox, console, palette, addProject, subagent, inspector, screens, app, cards, errors, notify, labels, deck, cardText, tauri, config, menu, session, done, stream, model, attach, tasks, update } as const;
/** flat `<ns>.<path>` → text; importing this module makes `en` usable. */
export const EN = addCatalog('en', EN_NS);
