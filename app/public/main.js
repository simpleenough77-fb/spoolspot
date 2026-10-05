// SPDX-License-Identifier: AGPL-3.0-or-later
// Entry point: take the development token, then load the counts, the tree and the placement check.
import { ApiError, setToken } from './api.js';
import { setupMove } from './movepage.js';
import { setupPlacement } from './placement.js';
import { showSummary } from './summary.js';
import { showTree } from './tree.js';

const form = document.getElementById('token-form');
const input = document.getElementById('token');
const status = document.getElementById('status');
if (!form || !input || !status) throw new Error('page elements are missing');

function fail(error) {
  if (error instanceof ApiError && error.status === 401) {
    setToken('');
    clearResults();
    status.textContent = 'That token was not accepted. Check it and try again.';
  } else if (error instanceof ApiError) {
    status.textContent = `The server could not load that (HTTP ${error.status}).`;
  } else if (error instanceof TypeError) {
    status.textContent = 'Could not reach the server. Check your network connection.';
  } else {
    status.textContent = 'The server sent data this page does not understand.';
  }
}

function clearResults() {
  document.getElementById('tree')?.replaceChildren();
  document.getElementById('summary-rows')?.replaceChildren();
  const summary = document.getElementById('summary');
  if (summary) summary.hidden = true;
  const placement = document.getElementById('placement');
  if (placement) placement.hidden = true;
  const move = document.getElementById('move-section');
  if (move) move.hidden = true;
}

// After a move, refresh the tree and the placement answer but keep the move section as it is.
async function reloadTree() {
  try {
    const nodes = await showTree();
    await showSummary();
    await setupPlacement(nodes, fail);
  } catch (error) {
    fail(error);
  }
}

async function load() {
  clearResults();
  status.textContent = 'Loading…';
  try {
    const nodes = await showTree();
    await showSummary();
    await setupPlacement(nodes, fail);
    await setupMove(nodes, fail, reloadTree);
    status.textContent = 'Loaded the location tree.';
  } catch (error) {
    fail(error);
  }
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  const token = input.value.trim();
  input.value = '';
  if (token) {
    setToken(token);
    void load();
  }
});
