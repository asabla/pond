// @ts-check
// Editors share one persistent value/base model. A restored draft keeps the base
// it was edited from, so a later save can detect an upstream change.
import { store } from "./dom.js";

export function createDraft(key, initial, identity = {}) {
  const saved = store(key);
  const legacy = typeof saved === "string" && typeof initial === "string";
  let data = saved?.version === 1 ? saved : { version: 1, value: legacy ? saved : initial, base: initial, identity };
  const write = () => store(key, data);
  return {
    get value() { return data.value; },
    get base() { return data.base; },
    get identity() { return data.identity; },
    get dirty() { return JSON.stringify(data.value) !== JSON.stringify(data.base); },
    change(value) { data = { ...data, value }; write(); },
    saved(value, nextIdentity = data.identity) { data = { version: 1, value, base: value, identity: nextIdentity }; write(); },
    conflicts(remote) { return JSON.stringify(remote) !== JSON.stringify(data.base); },
    clear() { store(key, null); },
  };
}
