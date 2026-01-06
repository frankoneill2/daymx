// Firebase client initialization for DayMX (ESM via CDN)
// Uses Anonymous Auth and Firestore. Exposes window.daymxFirebase helpers.

import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.13.1/firebase-app.js';
import { getAuth, onAuthStateChanged, signInAnonymously } from 'https://www.gstatic.com/firebasejs/10.13.1/firebase-auth.js';
import { getFirestore, enableIndexedDbPersistence, doc, getDoc, setDoc, onSnapshot } from 'https://www.gstatic.com/firebasejs/10.13.1/firebase-firestore.js';

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
const auth = getAuth(app);
const db = getFirestore(app);

// Best-effort offline support
enableIndexedDbPersistence(db).catch(() => {/* ignore multi-tab conflicts */});

function ensureDocRef(user) {
  const uid = user.uid;
  const ref = doc(db, 'daymx', uid);
  return ref;
}

const ready = new Promise((resolve) => {
  onAuthStateChanged(auth, async (user) => {
    try {
      if (!user) {
        await signInAnonymously(auth);
        return; // onAuthStateChanged will fire again
      }
      resolve(user);
    } catch (e) {
      console.warn('Auth error', e);
      resolve(null);
    }
  });
});

async function getData() {
  const user = auth.currentUser || await ready;
  if (!user) return null;
  const ref = ensureDocRef(user);
  const snap = await getDoc(ref);
  return snap.exists() ? snap.data() : null;
}

async function setData(data) {
  const user = auth.currentUser || await ready;
  if (!user) return;
  const ref = ensureDocRef(user);
  await setDoc(ref, data, { merge: false });
}

function subscribe(cb) {
  const user = auth.currentUser;
  if (!user) return () => {};
  const ref = ensureDocRef(user);
  return onSnapshot(ref, (snap) => cb(snap.exists() ? snap.data() : null));
}

window.daymxFirebase = { ready, getData, setData, subscribe };

