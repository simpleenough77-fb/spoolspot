// SPDX-License-Identifier: AGPL-3.0-or-later
// The non-NFC way to move a clip from the main page: pick a place, tap one of the clips stored there,
// then pick where it goes. Tap-only, same mover panel and confirm steps as the tap page.
import { ApiError } from './api.js';
import {
  clipLabel,
  createMoverPanel,
  fillPlacePicker,
  loadClipsAt,
  refusalMessage,
  stateLabel,
} from './mover.js';
import { leafPaths } from './tree.js';

let controller = null;

export async function setupMove(nodes, onError, reload) {
  const section = document.getElementById('move-section');
  const select = document.getElementById('move-from');
  const list = document.getElementById('move-clips');
  const slot = document.getElementById('move-panel');
  const note = document.getElementById('move-note');
  if (note) note.tabIndex = -1;
  if (!section || !select || !list || !slot || !note) throw new Error('move elements are missing');
  controller?.abort();
  controller = new AbortController();
  const { signal } = controller;
  const leaves = leafPaths(nodes);
  if (leaves.length === 0) {
    section.hidden = true;
    return;
  }
  fillPlacePicker(select, leaves);
  const panel = createMoverPanel(leaves, () => {
    note.textContent = 'Moved. The tree above is up to date.';
    note.focus();
    void reload();
    void refresh();
  });
  slot.replaceChildren(panel.element);
  let sequence = 0;
  const refresh = async () => {
    sequence += 1;
    const mine = sequence;
    try {
      const clips = await loadClipsAt(select.value);
      if (mine !== sequence) return;
      list.replaceChildren();
      for (const c of clips) {
        const li = document.createElement('li');
        const text = document.createElement('span');
        text.textContent = `${clipLabel(c)} (${stateLabel(c.state)})`;
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = 'Move';
        button.setAttribute('aria-label', `Move ${clipLabel(c)}`);
        button.addEventListener('click', () => {
          note.textContent = '';
          panel.show({ id: c.id, label: clipLabel(c) }, select.value);
        });
        li.append(text, button);
        list.append(li);
      }
      if (clips.length === 0) {
        const li = document.createElement('li');
        li.textContent = 'No clips here.';
        list.append(li);
      }
    } catch (error) {
      if (mine !== sequence) return;
      if (error instanceof ApiError && error.status !== 401)
        note.textContent = refusalMessage(error);
      else onError(error);
    }
  };
  select.addEventListener('change', () => void refresh(), { signal });
  section.hidden = false;
  await refresh();
}
