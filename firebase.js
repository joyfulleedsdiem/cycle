import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import {
  getAuth,
  onAuthStateChanged,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signInWithPopup,
  GoogleAuthProvider,
  signOut
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import {
  getFirestore,
  doc,
  getDoc,
  setDoc,
  deleteDoc
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyDG-sMzzHbYMofs4UTwddW7ZZUkZDwFgDI",
  authDomain: "cycle-calalder.firebaseapp.com",
  projectId: "cycle-calalder",
  storageBucket: "cycle-calalder.firebasestorage.app",
  messagingSenderId: "218034094057",
  appId: "1:218034094057:web:7158e6e1dee870415f1578"
};

const firebaseApp = initializeApp(firebaseConfig);
const auth = getAuth(firebaseApp);
const db = getFirestore(firebaseApp);

window.CycleAuth = {
  onAuthStateChanged(callback) {
    return onAuthStateChanged(auth, callback);
  },
  signUp(email, password) {
    return createUserWithEmailAndPassword(auth, email, password);
  },
  logIn(email, password) {
    return signInWithEmailAndPassword(auth, email, password);
  },
  signInWithGoogle() {
    return signInWithPopup(auth, new GoogleAuthProvider());
  },
  logOut() {
    return signOut(auth);
  },
  async getUserDoc(uid) {
    const snap = await getDoc(doc(db, "users", uid));
    return snap.exists() ? snap.data() : null;
  },
  async saveUserDoc(uid, data) {
    await setDoc(doc(db, "users", uid), data);
  },
  async deleteUserDoc(uid) {
    await deleteDoc(doc(db, "users", uid));
  }
};
