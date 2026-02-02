// Firebase client initialization for DayMX (ESM via CDN)
// Public single-doc mode: no sign-in required; all devices share one doc.
// Exposes window.daymxFirebase helpers.

import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.13.1/firebase-app.js';
import { getFirestore, enableIndexedDbPersistence, enableMultiTabIndexedDbPersistence, doc, getDoc, setDoc, onSnapshot } from 'https://www.gstatic.com/firebasejs/10.13.1/firebase-firestore.js';

const firebaseConfig = {
  apiKey: "AIzaSyAtAvBaBChONefrQtHGYgi9aC2s3Ztn_JI",
  authDomain: "daymx-a338f.firebaseapp.com",
  projectId: "daymx-a338f",
  storageBucket: "daymx-a338f.firebasestorage.app",
  messagingSenderId: "193298472196",
  appId: "1:193298472196:web:66cfc4d4654f0c9aa58451",
  measurementId: "G-S79XT07KVM"
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

async function canUseIndexedDb(timeoutMs = 300) {
  if (!('indexedDB' in window)) return false;
  try {
    const ok = await new Promise((resolve) => {
      let done = false;
      const finish = (val) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(val);
      };
      const timer = setTimeout(() => finish(false), timeoutMs);
      let req;
      try {
        req = indexedDB.open('daymx-idb-test');
      } catch {
        finish(false);
        return;
      }
      req.onerror = () => finish(false);
      req.onupgradeneeded = () => {
        try { req.result.createObjectStore('t'); } catch {}
      };
      req.onsuccess = () => {
        try { req.result.close(); } catch {}
        try { indexedDB.deleteDatabase('daymx-idb-test'); } catch {}
        finish(true);
      };
    });
    return ok;
  } catch {
    return false;
  }
}

// Best-effort offline support with multi-tab sync (avoid noisy errors if IndexedDB is blocked).
const ready = (async () => {
  if (await canUseIndexedDb()) {
    try {
      await enableMultiTabIndexedDbPersistence(db);
    } catch {
      try { await enableIndexedDbPersistence(db); } catch {}
    }
  }
  return true;
})();

// Single shared document path (public). Rules must permit read/write.
function ensureDocRef() {
  return doc(db, 'daymx', 'public');
}

// Ready resolves after (optional) persistence setup

async function getData() {
  await ready;
  const ref = ensureDocRef();
  const snap = await getDoc(ref);
  return snap.exists() ? snap.data() : null;
}

async function setData(data) {
  await ready;
  const ref = ensureDocRef();
  await setDoc(ref, data, { merge: false });
}

function subscribe(cb) {
  const ref = ensureDocRef();
  return onSnapshot(ref, (snap) => cb(snap.exists() ? snap.data() : null));
}

window.daymxFirebase = { ready, getData, setData, subscribe };
