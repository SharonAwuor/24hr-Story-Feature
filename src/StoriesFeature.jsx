import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { Plus, X, ChevronLeft, ChevronRight, ChevronDown, Check, ImageOff, Trash2, Pencil, Lock, Download, Upload, Camera, Loader2 } from "lucide-react";

/* ────────────────────────────────────────────────────────────────────────
   24-HOUR STORIES
   A client-side, localStorage-backed clone of the ephemeral "story" pattern.

   Design concept: each story's ring is a literal clock face for its
   remaining lifetime — full and sunrise-warm the moment it's posted,
   draining and cooling toward midnight-blue as the 24 hours burn down,
   then the story quietly removes itself. The countdown is the interface.
   ──────────────────────────────────────────────────────────────────────── */

const STORAGE_KEY = "storyclone.stories.v1";
const VIEWED_KEY = "storyclone.viewed.v1";
const PROFILES_KEY = "storyclone.profiles.v1";
const ACTIVE_PROFILE_KEY = "storyclone.active-profile.v1";
const LIFETIME_MS = 24 * 60 * 60 * 1000;
const MAX_W = 1080;
const MAX_H = 1920;
const SLIDE_MS = 5000;

// This is still a client-side-only app — there's no login or server, so
// "users" here are local profiles you switch between in one browser, not
// authenticated accounts. Whichever profile is active gets tagged as the
// authorId on anything you post, which is what makes distinct circles work.
const DEFAULT_PROFILE = { id: "you", name: "You", color: "#ffb84d" };
const PROFILE_COLORS = ["#ffb84d", "#ff6b4a", "#7c5cff", "#4ac9ff", "#5ce6a6", "#ff5ca8"];

// Color stops the ring travels through as a story ages: dawn → gold → dusk → night
const AGE_STOPS = [
  { t: 0, c: [255, 107, 74] },   // sunrise orange
  { t: 0.33, c: [255, 194, 77] }, // gold
  { t: 0.66, c: [124, 92, 255] }, // dusk violet
  { t: 1, c: [46, 58, 89] },     // night blue
];

function ringColor(fraction) {
  const f = Math.min(1, Math.max(0, fraction));
  let a = AGE_STOPS[0], b = AGE_STOPS[AGE_STOPS.length - 1];
  for (let i = 0; i < AGE_STOPS.length - 1; i++) {
    if (f >= AGE_STOPS[i].t && f <= AGE_STOPS[i + 1].t) {
      a = AGE_STOPS[i];
      b = AGE_STOPS[i + 1];
      break;
    }
  }
  const span = b.t - a.t || 1;
  const local = (f - a.t) / span;
  const c = a.c.map((v, i) => Math.round(v + (b.c[i] - v) * local));
  return `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
}

function formatRemaining(ms) {
  if (ms <= 0) return "expired";
  const totalMin = Math.ceil(ms / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h >= 1) return `${h}h left`;
  return `${m}m left`;
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function resizeImageToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Could not read file"));
    reader.onload = (e) => {
      const img = new Image();
      img.onerror = () => reject(new Error("Could not decode image"));
      img.onload = () => {
        const scale = Math.min(1, MAX_W / img.width, MAX_H / img.height);
        const w = Math.max(1, Math.round(img.width * scale));
        const h = Math.max(1, Math.round(img.height * scale));
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL("image/jpeg", 0.85));
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  });
}

function loadStories() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    const now = Date.now();
    return parsed
      .filter((s) => now - s.createdAt < LIFETIME_MS)
      .sort((a, b) => b.createdAt - a.createdAt);
  } catch {
    return [];
  }
}

function persistStories(stories) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(stories));
    return true;
  } catch {
    return false;
  }
}

function loadViewedIds() {
  try {
    const raw = localStorage.getItem(VIEWED_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function persistViewedIds(ids) {
  try {
    localStorage.setItem(VIEWED_KEY, JSON.stringify(ids));
  } catch {
    /* non-critical — viewed state just won't persist across reloads */
  }
}

function loadProfiles() {
  try {
    const raw = localStorage.getItem(PROFILES_KEY);
    if (!raw) return [DEFAULT_PROFILE];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.length ? parsed : [DEFAULT_PROFILE];
  } catch {
    return [DEFAULT_PROFILE];
  }
}

function persistProfiles(profiles) {
  try {
    localStorage.setItem(PROFILES_KEY, JSON.stringify(profiles));
  } catch {
    /* non-critical */
  }
}

function loadActiveProfileId() {
  try {
    return localStorage.getItem(ACTIVE_PROFILE_KEY) || DEFAULT_PROFILE.id;
  } catch {
    return DEFAULT_PROFILE.id;
  }
}

function persistActiveProfileId(id) {
  try {
    localStorage.setItem(ACTIVE_PROFILE_KEY, id);
  } catch {
    /* non-critical */
  }
}

// One circle per author: bucket stories by authorId, then order each
// author's own stories oldest-first so their reel plays in the order posted.
function groupStoriesByAuthor(stories) {
  const map = new Map();
  for (const s of stories) {
    const authorId = s.authorId || DEFAULT_PROFILE.id;
    const authorName = s.authorName || DEFAULT_PROFILE.name;
    if (!map.has(authorId)) map.set(authorId, { authorId, authorName, stories: [] });
    map.get(authorId).stories.push(s);
  }
  const groups = [...map.values()];
  for (const g of groups) g.stories.sort((a, b) => a.createdAt - b.createdAt);
  return groups;
}

export default function StoriesFeature() {
  const [stories, setStories] = useState([]);
  const [now, setNow] = useState(Date.now());
  const [viewerReel, setViewerReel] = useState(null); // { stories, startIndex } | null
  const [error, setError] = useState("");
  const [viewedIds, setViewedIds] = useState(() => new Set(loadViewedIds()));
  const [profiles, setProfiles] = useState(() => loadProfiles());
  const [activeProfileId, setActiveProfileId] = useState(() => loadActiveProfileId());
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [newProfileName, setNewProfileName] = useState("");
  const [editingProfileId, setEditingProfileId] = useState(null);
  const [editName, setEditName] = useState("");
  const [editPin, setEditPin] = useState("");
  const [pinPrompt, setPinPrompt] = useState(null); // { profileId, error } | null
  const [pinInput, setPinInput] = useState("");
  const [uploadingCount, setUploadingCount] = useState(0);
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [pendingDeleteIds, setPendingDeleteIds] = useState(() => new Set());
  const [toast, setToast] = useState(null); // { id, label } | null
  const fileInputRef = useRef(null);
  const cameraInputRef = useRef(null);
  const importInputRef = useRef(null);
  const switcherRef = useRef(null);
  const addMenuRef = useRef(null);
  const deleteTimersRef = useRef(new Map());
  const dragCounterRef = useRef(0);

  const activeProfile = profiles.find((p) => p.id === activeProfileId) || profiles[0] || DEFAULT_PROFILE;

  // close the profile switcher on outside click
  useEffect(() => {
    if (!switcherOpen) return;
    const onDocClick = (e) => {
      if (switcherRef.current && !switcherRef.current.contains(e.target)) {
        setSwitcherOpen(false);
        setNewProfileName("");
        setEditingProfileId(null);
        setPinPrompt(null);
      }
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [switcherOpen]);

  // close the add-source (camera/gallery) menu on outside click
  useEffect(() => {
    if (!addMenuOpen) return;
    const onDocClick = (e) => {
      if (addMenuRef.current && !addMenuRef.current.contains(e.target)) {
        setAddMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [addMenuOpen]);

  // don't leave dangling undo timers behind if the component unmounts
  useEffect(() => {
    return () => {
      deleteTimersRef.current.forEach((t) => clearTimeout(t));
      deleteTimersRef.current.clear();
    };
  }, []);

  const switchProfile = (id) => {
    setActiveProfileId(id);
    persistActiveProfileId(id);
    setSwitcherOpen(false);
    setPinPrompt(null);
    setPinInput("");
  };

  // locked profiles need their PIN entered before switching; this is a
  // local UI gate stored in plain text in localStorage, not real security —
  // it's meant to stop casual switching on a shared device, not attackers.
  const requestSwitch = (p) => {
    if (p.id === activeProfile.id) {
      setSwitcherOpen(false);
      return;
    }
    if (p.pin) {
      setPinPrompt({ profileId: p.id, error: "" });
      setPinInput("");
    } else {
      switchProfile(p.id);
    }
  };

  const confirmPin = () => {
    const p = profiles.find((pr) => pr.id === pinPrompt?.profileId);
    if (!p) return;
    if (pinInput === p.pin) {
      switchProfile(p.id);
    } else {
      setPinPrompt((prev) => ({ ...prev, error: "Incorrect PIN" }));
    }
  };

  const startEditProfile = (p) => {
    setEditingProfileId(p.id);
    setEditName(p.name);
    setEditPin(p.pin || "");
  };

  const cancelEditProfile = () => {
    setEditingProfileId(null);
    setEditName("");
    setEditPin("");
  };

  const saveEditProfile = () => {
    const name = editName.trim();
    if (!name) return;
    const pin = editPin.trim() || null;
    setProfiles((prev) => {
      const next = prev.map((p) => (p.id === editingProfileId ? { ...p, name, pin } : p));
      persistProfiles(next);
      return next;
    });
    // keep already-posted stories' displayed name in sync with the rename
    setStories((prev) => {
      const next = prev.map((s) => (s.authorId === editingProfileId ? { ...s, authorName: name } : s));
      persistStories(next);
      return next;
    });
    cancelEditProfile();
  };

  const deleteProfile = (p) => {
    if (profiles.length <= 1) {
      setError("You need at least one profile — create another before deleting this one.");
      return;
    }
    const ok = window.confirm(`Delete "${p.name}"? This also removes their active stories.`);
    if (!ok) return;
    const remaining = profiles.filter((pr) => pr.id !== p.id);
    setProfiles(remaining);
    persistProfiles(remaining);
    setStories((prev) => {
      const next = prev.filter((s) => s.authorId !== p.id);
      persistStories(next);
      return next;
    });
    if (activeProfile.id === p.id) {
      switchProfile(remaining[0].id);
    }
    if (editingProfileId === p.id) cancelEditProfile();
  };

  const exportData = () => {
    const payload = {
      kind: "storyclone-backup",
      version: 1,
      exportedAt: Date.now(),
      profiles,
      stories,
      viewedIds: [...viewedIds],
      activeProfileId: activeProfile.id,
    };
    try {
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `stories-backup-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch {
      setError("Couldn't export — your browser blocked the download.");
    }
  };

  const onImportFile = (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const data = JSON.parse(ev.target.result);
        if (!data || !Array.isArray(data.profiles) || !Array.isArray(data.stories)) {
          setError("That file doesn't look like a stories backup.");
          return;
        }
        const nowTs = Date.now();
        const freshStories = data.stories.filter((s) => nowTs - s.createdAt < LIFETIME_MS);
        const nextProfiles = data.profiles.length ? data.profiles : [DEFAULT_PROFILE];
        const nextViewed = Array.isArray(data.viewedIds) ? data.viewedIds : [];
        const nextActive =
          data.activeProfileId && nextProfiles.some((p) => p.id === data.activeProfileId)
            ? data.activeProfileId
            : nextProfiles[0].id;

        setProfiles(nextProfiles);
        persistProfiles(nextProfiles);
        setStories(freshStories);
        persistStories(freshStories);
        setViewedIds(new Set(nextViewed));
        persistViewedIds(nextViewed);
        setActiveProfileId(nextActive);
        persistActiveProfileId(nextActive);
        setSwitcherOpen(false);
        setError("");
      } catch {
        setError("Couldn't read that backup file.");
      }
    };
    reader.readAsText(file);
  };

  const addProfile = () => {
    const name = newProfileName.trim();
    if (!name) return;
    const id = `p-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const color = PROFILE_COLORS[profiles.length % PROFILE_COLORS.length];
    const profile = { id, name, color, pin: null };
    setProfiles((prev) => {
      const next = [...prev, profile];
      persistProfiles(next);
      return next;
    });
    setNewProfileName("");
    switchProfile(id);
  };

  // initial load
  useEffect(() => {
    setStories(loadStories());
  }, []);

  const markViewed = useCallback((id) => {
    setViewedIds((prev) => {
      if (prev.has(id)) return prev;
      const next = new Set(prev);
      next.add(id);
      persistViewedIds([...next]);
      return next;
    });
  }, []);

  // tick every 30s so rings/countdowns update, and sweep expired stories
  useEffect(() => {
    const id = setInterval(() => {
      setNow(Date.now());
      setStories((prev) => {
        const fresh = prev.filter((s) => Date.now() - s.createdAt < LIFETIME_MS);
        if (fresh.length !== prev.length) persistStories(fresh);
        return fresh;
      });
    }, 30000);
    return () => clearInterval(id);
  }, []);

  const handleFiles = useCallback(async (fileList) => {
    const files = Array.from(fileList || []).filter((f) => f.type && f.type.startsWith("image/"));
    if (!files.length) {
      setError("Please choose an image file.");
      return;
    }
    setError("");
    setUploadingCount((c) => c + files.length);
    let anyFailed = false;
    for (const file of files) {
      try {
        const dataUrl = await resizeImageToDataUrl(file);
        const story = {
          id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
          image: dataUrl,
          createdAt: Date.now(),
          authorId: activeProfile.id,
          authorName: activeProfile.name,
        };
        setStories((prev) => {
          const next = [story, ...prev];
          const ok = persistStories(next);
          if (!ok) {
            setError("Storage is full — delete an older story to add a new one.");
            return prev;
          }
          return next;
        });
      } catch {
        anyFailed = true;
      } finally {
        setUploadingCount((c) => Math.max(0, c - 1));
      }
    }
    if (anyFailed) setError("Couldn't process one or more of those images.");
  }, [activeProfile]);

  const onPickFile = (e) => {
    handleFiles(e.target.files);
    e.target.value = "";
  };

  const onCameraCapture = (e) => {
    handleFiles(e.target.files);
    e.target.value = "";
  };

  // drag-and-drop upload anywhere on the widget
  const onDragEnter = (e) => {
    e.preventDefault();
    if (e.dataTransfer?.types?.includes("Files")) {
      dragCounterRef.current += 1;
      setDragActive(true);
    }
  };
  const onDragOver = (e) => {
    e.preventDefault();
  };
  const onDragLeave = (e) => {
    e.preventDefault();
    dragCounterRef.current = Math.max(0, dragCounterRef.current - 1);
    if (dragCounterRef.current === 0) setDragActive(false);
  };
  const onDrop = (e) => {
    e.preventDefault();
    dragCounterRef.current = 0;
    setDragActive(false);
    if (e.dataTransfer?.files?.length) handleFiles(e.dataTransfer.files);
  };

  // paste-to-upload anywhere on the page while this widget is mounted
  useEffect(() => {
    const onPaste = (e) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      const files = [];
      for (const item of items) {
        if (item.kind === "file" && item.type.startsWith("image/")) {
          const f = item.getAsFile();
          if (f) files.push(f);
        }
      }
      if (files.length) handleFiles(files);
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [handleFiles]);

  const visibleStories = useMemo(
    () => stories.filter((s) => !pendingDeleteIds.has(s.id)),
    [stories, pendingDeleteIds]
  );

  const deleteStory = (id) => {
    setViewerReel(null);
    setPendingDeleteIds((prev) => new Set(prev).add(id));
    setToast({ id, label: "Story deleted" });
    const timer = setTimeout(() => {
      setStories((prev) => {
        const next = prev.filter((s) => s.id !== id);
        persistStories(next);
        return next;
      });
      setPendingDeleteIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      deleteTimersRef.current.delete(id);
      setToast((t) => (t && t.id === id ? null : t));
    }, 5000);
    deleteTimersRef.current.set(id, timer);
  };

  const undoDelete = (id) => {
    const timer = deleteTimersRef.current.get(id);
    if (timer) clearTimeout(timer);
    deleteTimersRef.current.delete(id);
    setPendingDeleteIds((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
    setToast((t) => (t && t.id === id ? null : t));
  };

  const storageUsageBytes = useMemo(() => {
    try {
      return (
        JSON.stringify(stories).length +
        JSON.stringify([...viewedIds]).length +
        JSON.stringify(profiles).length
      ) * 2; // rough UTF-16 byte estimate
    } catch {
      return 0;
    }
  }, [stories, viewedIds, profiles]);
  const STORAGE_BUDGET_BYTES = 5 * 1024 * 1024; // conservative; real limit is usually 5-10MB
  const storagePercent = Math.min(100, (storageUsageBytes / STORAGE_BUDGET_BYTES) * 100);

  return (
    <div
      className={`sc-root ${dragActive ? "is-drag-active" : ""}`}
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <style>{`
        .sc-root {
          --bg: #0b0e14;
          --surface: #12161f;
          --surface-2: #1a1f2b;
          --text: #eef1f6;
          --text-dim: #8b93a3;
          --ring-track: #262c39;
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, sans-serif;
          background: var(--bg);
          color: var(--text);
          min-height: 100%;
          padding: 20px 16px 40px;
          box-sizing: border-box;
          position: relative;
          transition: outline-color 0.15s ease;
          outline: 2px dashed transparent;
          outline-offset: -8px;
        }
        .sc-root.is-drag-active {
          outline-color: #ffb84d;
          background: #12141b;
        }
        .sc-drop-hint {
          position: absolute;
          inset: 8px;
          border-radius: 14px;
          display: none;
          align-items: center;
          justify-content: center;
          font-size: 13px;
          color: #ffb84d;
          background: rgba(11, 14, 20, 0.85);
          pointer-events: none;
          z-index: 30;
        }
        .sc-root.is-drag-active .sc-drop-hint { display: flex; }
        @media (prefers-reduced-motion: reduce) {
          .sc-root *:not(.sc-spin), .sc-root *:not(.sc-spin)::before, .sc-root *:not(.sc-spin)::after {
            transition-duration: 0.001ms !important;
            animation-duration: 0.001ms !important;
            animation-iteration-count: 1 !important;
          }
        }
        .sc-header {
          font-size: 13px;
          letter-spacing: 0.14em;
          text-transform: uppercase;
          color: var(--text-dim);
          margin: 0 4px 14px;
          display: flex;
          align-items: center;
          justify-content: space-between;
        }
        .sc-header strong {
          color: var(--text);
          font-size: 13px;
          letter-spacing: 0.14em;
        }
        .sc-switcher {
          position: relative;
          text-transform: none;
          letter-spacing: normal;
        }
        .sc-switcher-chip {
          display: flex;
          align-items: center;
          gap: 6px;
          background: var(--surface);
          border: 1px solid var(--surface-2);
          border-radius: 999px;
          padding: 4px 10px 4px 4px;
          color: var(--text);
          cursor: pointer;
        }
        .sc-switcher-chip:hover { border-color: #3a4152; }
        .sc-switcher-name {
          font-size: 12.5px;
          max-width: 90px;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .sc-initial-avatar {
          width: 22px;
          height: 22px;
          border-radius: 50%;
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 11px;
          font-weight: 700;
          color: #14161c;
          flex: 0 0 auto;
        }
        .sc-initial-avatar.sm { width: 20px; height: 20px; font-size: 10px; }
        .sc-switcher-pop {
          position: absolute;
          top: calc(100% + 8px);
          right: 0;
          width: 248px;
          background: var(--surface);
          border: 1px solid var(--surface-2);
          border-radius: 12px;
          padding: 8px;
          box-shadow: 0 12px 32px rgba(0,0,0,0.4);
          z-index: 20;
        }
        .sc-switcher-label {
          font-size: 10.5px;
          letter-spacing: 0.1em;
          text-transform: uppercase;
          color: var(--text-dim);
          padding: 4px 8px 6px;
        }
        .sc-profile-row {
          width: 100%;
          display: flex;
          align-items: center;
          gap: 2px;
          border-radius: 8px;
        }
        .sc-profile-row:hover { background: var(--surface-2); }
        .sc-profile-row.is-active { background: var(--surface-2); }
        .sc-profile-row-main {
          flex: 1;
          min-width: 0;
          display: flex;
          align-items: center;
          gap: 8px;
          background: transparent;
          border: none;
          color: var(--text);
          padding: 7px 6px;
          border-radius: 8px;
          cursor: pointer;
          font-size: 13px;
        }
        .sc-lock-icon { color: var(--text-dim); flex: 0 0 auto; }
        .sc-row-icon-btn {
          flex: 0 0 auto;
          width: 24px;
          height: 24px;
          border-radius: 6px;
          border: none;
          background: transparent;
          color: var(--text-dim);
          display: flex;
          align-items: center;
          justify-content: center;
          cursor: pointer;
        }
        .sc-row-icon-btn:hover { background: #2a3140; color: var(--text); }
        .sc-profile-row-name {
          flex: 1;
          text-align: left;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .sc-profile-edit {
          display: flex;
          flex-direction: column;
          gap: 6px;
          padding: 8px;
          background: var(--surface-2);
          border-radius: 8px;
          margin-bottom: 2px;
        }
        .sc-pin-hint {
          font-size: 10px;
          color: var(--text-dim);
          line-height: 1.3;
        }
        .sc-pin-actions {
          display: flex;
          justify-content: flex-end;
          gap: 6px;
          margin-top: 2px;
        }
        .sc-pin-cancel, .sc-pin-confirm {
          font-size: 12px;
          padding: 6px 10px;
          border-radius: 7px;
          border: none;
          cursor: pointer;
        }
        .sc-pin-cancel {
          background: transparent;
          color: var(--text-dim);
        }
        .sc-pin-cancel:hover { color: var(--text); }
        .sc-pin-confirm {
          background: #ffb84d;
          color: #1a1200;
          font-weight: 600;
        }
        .sc-pin-confirm:disabled {
          background: var(--surface-2);
          color: var(--text-dim);
          cursor: default;
        }
        .sc-pin-prompt {
          display: flex;
          flex-direction: column;
          gap: 8px;
          padding: 4px;
        }
        .sc-pin-error {
          font-size: 11.5px;
          color: #ff8a7a;
        }
        .sc-data-actions {
          display: flex;
          gap: 6px;
          padding: 2px;
        }
        .sc-data-btn {
          flex: 1;
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 5px;
          font-size: 11.5px;
          padding: 7px 6px;
          border-radius: 8px;
          border: 1px solid #2a3140;
          background: transparent;
          color: var(--text-dim);
          cursor: pointer;
        }
        .sc-data-btn:hover { color: var(--text); border-color: #3a4152; }
        .sc-switcher-divider {
          height: 1px;
          background: var(--surface-2);
          margin: 6px 2px;
        }
        .sc-new-profile-row {
          display: flex;
          gap: 6px;
          padding: 2px;
        }
        .sc-new-profile-input {
          flex: 1;
          min-width: 0;
          background: var(--surface-2);
          border: 1px solid #2a3140;
          border-radius: 8px;
          padding: 7px 9px;
          color: var(--text);
          font-size: 12.5px;
        }
        .sc-new-profile-input:focus {
          outline: none;
          border-color: #ffb84d;
        }
        .sc-new-profile-btn {
          width: 32px;
          height: 32px;
          border-radius: 8px;
          border: none;
          background: #ffb84d;
          color: #1a1200;
          display: flex;
          align-items: center;
          justify-content: center;
          cursor: pointer;
          flex: 0 0 auto;
        }
        .sc-new-profile-btn:disabled {
          background: var(--surface-2);
          color: var(--text-dim);
          cursor: default;
        }
        .sc-strip {
          display: flex;
          gap: 16px;
          overflow-x: auto;
          padding: 4px 4px 12px;
          scrollbar-width: thin;
          -webkit-overflow-scrolling: touch;
        }
        .sc-strip::-webkit-scrollbar { height: 6px; }
        .sc-strip::-webkit-scrollbar-thumb { background: var(--surface-2); border-radius: 4px; }

        .sc-item {
          flex: 0 0 auto;
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 6px;
          width: 72px;
        }
        .sc-avatar-wrap {
          position: relative;
          width: 66px;
          height: 66px;
          display: flex;
          align-items: center;
          justify-content: center;
          cursor: pointer;
          border-radius: 50%;
          -webkit-tap-highlight-color: transparent;
        }
        .sc-avatar-wrap:focus-visible {
          outline: 2px solid #ffb84d;
          outline-offset: 3px;
        }
        .sc-avatar-wrap:active .sc-thumb {
          transform: scale(0.94);
        }
        .sc-ring {
          position: absolute;
          inset: 0;
          transform: rotate(-90deg);
          pointer-events: none;
        }
        .sc-thumb {
          width: 56px;
          height: 56px;
          border-radius: 50%;
          object-fit: cover;
          background: var(--surface-2);
          border: 2px solid var(--bg);
          transition: transform 0.1s ease, opacity 0.3s ease;
          pointer-events: none;
        }
        .sc-label {
          font-size: 11px;
          color: var(--text-dim);
          max-width: 72px;
          text-align: center;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .sc-sublabel {
          font-size: 9.5px;
          color: #5b6472;
          max-width: 72px;
          text-align: center;
          white-space: nowrap;
        }
        .sc-plus-badge {
          position: absolute;
          bottom: -1px;
          right: -1px;
          width: 18px;
          height: 18px;
          border-radius: 50%;
          background: #ffb84d;
          border: 2px solid var(--bg);
          color: #1a1200;
          display: flex;
          align-items: center;
          justify-content: center;
          cursor: pointer;
          padding: 0;
        }
        .sc-plus-badge:hover { background: #ffc866; }
        .sc-add-btn {
          width: 56px;
          height: 56px;
          border-radius: 50%;
          border: 1.5px dashed var(--text-dim);
          background: var(--surface);
          color: var(--text-dim);
          display: flex;
          align-items: center;
          justify-content: center;
          cursor: pointer;
          transition: border-color 0.15s, color 0.15s, transform 0.1s;
        }
        .sc-add-btn:hover { border-color: #ffb84d; color: #ffb84d; }
        .sc-add-btn:active { transform: scale(0.94); }

        .sc-add-menu-wrap { position: relative; }
        .sc-add-menu {
          position: absolute;
          top: calc(100% + 8px);
          left: 0;
          width: 176px;
          background: var(--surface);
          border: 1px solid var(--surface-2);
          border-radius: 12px;
          padding: 6px;
          box-shadow: 0 12px 32px rgba(0,0,0,0.4);
          z-index: 20;
        }
        .sc-add-menu-item {
          width: 100%;
          display: flex;
          align-items: center;
          gap: 9px;
          background: transparent;
          border: none;
          color: var(--text);
          padding: 9px 8px;
          border-radius: 8px;
          cursor: pointer;
          font-size: 13px;
        }
        .sc-add-menu-item:hover { background: var(--surface-2); }

        .sc-upload-spinner {
          position: absolute;
          inset: 0;
          border-radius: 50%;
          background: rgba(11, 14, 20, 0.72);
          display: flex;
          align-items: center;
          justify-content: center;
          color: #ffb84d;
        }
        .sc-spin { animation: sc-spin-kf 0.9s linear infinite; }
        @keyframes sc-spin-kf { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }

        .sc-empty-hint {
          color: var(--text-dim);
          font-size: 13px;
          padding: 6px 4px 0;
        }
        .sc-hint-row {
          color: var(--text-dim);
          font-size: 11.5px;
          padding: 2px 4px 0;
        }
        .sc-error {
          color: #ff8a7a;
          font-size: 12.5px;
          margin: 8px 4px 0;
        }

        .sc-storage-meter-wrap {
          margin: 14px 4px 0;
        }
        .sc-storage-meter {
          height: 4px;
          border-radius: 3px;
          background: var(--surface-2);
          overflow: hidden;
        }
        .sc-storage-meter-fill {
          height: 100%;
          border-radius: 3px;
          transition: width 0.4s ease;
        }
        .sc-storage-label {
          font-size: 10.5px;
          color: var(--text-dim);
          margin-top: 5px;
        }

        .sc-toast {
          position: fixed;
          left: 50%;
          bottom: 22px;
          transform: translateX(-50%);
          background: #1a1f2b;
          border: 1px solid #2a3140;
          color: var(--text);
          padding: 10px 12px 10px 16px;
          border-radius: 999px;
          display: flex;
          align-items: center;
          gap: 14px;
          font-size: 13px;
          box-shadow: 0 12px 32px rgba(0,0,0,0.45);
          z-index: 1100;
        }
        .sc-toast-undo {
          background: transparent;
          border: none;
          color: #ffb84d;
          font-weight: 600;
          font-size: 13px;
          cursor: pointer;
          padding: 4px 6px;
        }

        .sc-viewer-overlay {
          position: fixed;
          inset: 0;
          background: #000;
          z-index: 1000;
          display: flex;
          align-items: center;
          justify-content: center;
          -webkit-user-select: none;
          user-select: none;
        }
        .sc-viewer-frame {
          position: relative;
          width: 100%;
          height: 100%;
          max-width: 480px;
          background: #000;
          overflow: hidden;
        }
        @media (min-width: 480px) {
          .sc-viewer-frame { max-height: 92vh; border-radius: 14px; }
        }
        .sc-viewer-img {
          width: 100%;
          height: 100%;
          object-fit: contain;
          background: #000;
          pointer-events: none;
        }
        .sc-bars {
          position: absolute;
          top: 10px;
          left: 10px;
          right: 10px;
          display: flex;
          gap: 4px;
          z-index: 5;
        }
        .sc-bar-track {
          flex: 1;
          height: 2.5px;
          background: rgba(255,255,255,0.3);
          border-radius: 2px;
          overflow: hidden;
        }
        .sc-bar-fill {
          height: 100%;
          background: #fff;
          width: 0%;
        }
        .sc-viewer-top {
          position: absolute;
          top: 22px;
          left: 10px;
          right: 10px;
          display: flex;
          align-items: center;
          justify-content: space-between;
          z-index: 5;
          color: #fff;
        }
        .sc-viewer-meta {
          font-size: 12.5px;
          color: rgba(255,255,255,0.85);
          text-shadow: 0 1px 3px rgba(0,0,0,0.5);
        }
        .sc-viewer-actions {
          display: flex;
          gap: 14px;
          align-items: center;
        }
        .sc-icon-btn {
          background: rgba(0,0,0,0.35);
          border: none;
          color: #fff;
          width: 32px;
          height: 32px;
          border-radius: 50%;
          display: flex;
          align-items: center;
          justify-content: center;
          cursor: pointer;
        }
        .sc-nav-zone {
          position: absolute;
          top: 0;
          bottom: 0;
          width: 32%;
          z-index: 4;
          display: none;
          align-items: center;
          cursor: pointer;
          background: transparent;
          border: none;
          color: rgba(255,255,255,0.55);
        }
        @media (min-width: 700px) {
          .sc-nav-zone { display: flex; }
        }
        .sc-nav-zone.left { left: 0; justify-content: flex-start; padding-left: 6px; }
        .sc-nav-zone.right { right: 0; justify-content: flex-end; padding-right: 6px; }
        .sc-touch-zone {
          position: absolute;
          top: 60px;
          bottom: 0;
          width: 50%;
          z-index: 3;
        }
        .sc-touch-zone.left { left: 0; }
        .sc-touch-zone.right { right: 0; }
      `}</style>

      <div className="sc-header">
        <strong>Stories</strong>
        <div className="sc-switcher" ref={switcherRef}>
          <button
            className="sc-switcher-chip"
            onClick={() => setSwitcherOpen((v) => !v)}
            aria-haspopup="true"
            aria-expanded={switcherOpen}
          >
            <span className="sc-initial-avatar" style={{ background: activeProfile.color }}>
              {activeProfile.name.trim().charAt(0).toUpperCase() || "?"}
            </span>
            <span className="sc-switcher-name">{activeProfile.name}</span>
            <ChevronDown size={13} />
          </button>

          {switcherOpen && (
            <div className="sc-switcher-pop">
              {pinPrompt ? (
                (() => {
                  const p = profiles.find((pr) => pr.id === pinPrompt.profileId);
                  if (!p) return null;
                  return (
                    <div className="sc-pin-prompt">
                      <div className="sc-switcher-label">Enter PIN for {p.name}</div>
                      <input
                        className="sc-new-profile-input"
                        type="password"
                        inputMode="numeric"
                        autoFocus
                        value={pinInput}
                        onChange={(e) => setPinInput(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") confirmPin();
                          if (e.key === "Escape") setPinPrompt(null);
                        }}
                      />
                      {pinPrompt.error && <div className="sc-pin-error">{pinPrompt.error}</div>}
                      <div className="sc-pin-actions">
                        <button className="sc-pin-cancel" onClick={() => setPinPrompt(null)}>Cancel</button>
                        <button className="sc-pin-confirm" onClick={confirmPin}>Unlock</button>
                      </div>
                    </div>
                  );
                })()
              ) : (
                <>
                  <div className="sc-switcher-label">Posting as</div>
                  {profiles.map((p) =>
                    editingProfileId === p.id ? (
                      <div className="sc-profile-edit" key={p.id}>
                        <input
                          className="sc-new-profile-input"
                          placeholder="Name"
                          value={editName}
                          maxLength={24}
                          autoFocus
                          onChange={(e) => setEditName(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") saveEditProfile();
                            if (e.key === "Escape") cancelEditProfile();
                          }}
                        />
                        <input
                          className="sc-new-profile-input"
                          placeholder="PIN (optional)"
                          type="password"
                          inputMode="numeric"
                          maxLength={8}
                          value={editPin}
                          onChange={(e) => setEditPin(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") saveEditProfile();
                            if (e.key === "Escape") cancelEditProfile();
                          }}
                        />
                        <div className="sc-pin-hint">Local device lock only — not real security.</div>
                        <div className="sc-pin-actions">
                          <button className="sc-pin-cancel" onClick={cancelEditProfile}>Cancel</button>
                          <button className="sc-pin-confirm" onClick={saveEditProfile} disabled={!editName.trim()}>Save</button>
                        </div>
                      </div>
                    ) : (
                      <div
                        className={`sc-profile-row ${p.id === activeProfile.id ? "is-active" : ""}`}
                        key={p.id}
                      >
                        <button className="sc-profile-row-main" onClick={() => requestSwitch(p)}>
                          <span className="sc-initial-avatar sm" style={{ background: p.color }}>
                            {p.name.trim().charAt(0).toUpperCase() || "?"}
                          </span>
                          <span className="sc-profile-row-name">{p.name}</span>
                          {p.pin && <Lock size={11} className="sc-lock-icon" />}
                          {p.id === activeProfile.id && <Check size={14} />}
                        </button>
                        <button
                          className="sc-row-icon-btn"
                          aria-label={`Edit ${p.name}`}
                          onClick={() => startEditProfile(p)}
                        >
                          <Pencil size={12} />
                        </button>
                        <button
                          className="sc-row-icon-btn"
                          aria-label={`Delete ${p.name}`}
                          onClick={() => deleteProfile(p)}
                        >
                          <Trash2 size={12} />
                        </button>
                      </div>
                    )
                  )}
                  <div className="sc-switcher-divider" />
                  <div className="sc-new-profile-row">
                    <input
                      className="sc-new-profile-input"
                      placeholder="New profile name"
                      value={newProfileName}
                      maxLength={24}
                      onChange={(e) => setNewProfileName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") addProfile();
                      }}
                    />
                    <button
                      className="sc-new-profile-btn"
                      onClick={addProfile}
                      disabled={!newProfileName.trim()}
                      aria-label="Create profile"
                    >
                      <Plus size={14} />
                    </button>
                  </div>
                  <div className="sc-switcher-divider" />
                  <div className="sc-data-actions">
                    <button className="sc-data-btn" onClick={exportData}>
                      <Download size={12} /> Export
                    </button>
                    <button className="sc-data-btn" onClick={() => importInputRef.current?.click()}>
                      <Upload size={12} /> Import
                    </button>
                  </div>
                  <input
                    ref={importInputRef}
                    type="file"
                    accept="application/json"
                    style={{ display: "none" }}
                    onChange={onImportFile}
                  />
                </>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="sc-drop-hint">Drop images to post a story</div>

      <div className="sc-strip">
        {(() => {
          const groups = groupStoriesByAuthor(visibleStories);
          const myGroup = groups.find((g) => g.authorId === activeProfile.id) || null;
          const otherGroups = groups.filter((g) => g.authorId !== activeProfile.id);

          const openGroup = (group) => {
            const startIndex = group.stories.findIndex((s) => !viewedIds.has(s.id));
            setViewerReel({ stories: group.stories, startIndex: startIndex === -1 ? 0 : startIndex });
            markViewed(group.stories[startIndex === -1 ? 0 : startIndex].id);
          };

          const openAddMenu = () => setAddMenuOpen((v) => !v);

          const renderGroupCircle = (group, { withPlusBadge } = {}) => {
            const allViewed = group.stories.every((s) => viewedIds.has(s.id));
            const oldest = group.stories[0];
            const newest = group.stories[group.stories.length - 1];
            const fraction = Math.min(1, (now - oldest.createdAt) / LIFETIME_MS);
            const remaining = LIFETIME_MS - (now - oldest.createdAt);
            const circumference = 2 * Math.PI * 30;
            const color = allViewed ? "#3a4152" : ringColor(fraction);
            return (
              <div className="sc-item" key={group.authorId}>
                <div
                  className="sc-avatar-wrap"
                  role="button"
                  tabIndex={0}
                  aria-label={`${group.authorName}, ${group.stories.length} ${group.stories.length === 1 ? "story" : "stories"}, ${allViewed ? "viewed" : "unviewed"}`}
                  onClick={() => openGroup(group)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      openGroup(group);
                    }
                  }}
                >
                  <svg className="sc-ring" width="66" height="66" viewBox="0 0 66 66" aria-hidden="true">
                    <circle cx="33" cy="33" r="30" fill="none" stroke="var(--ring-track)" strokeWidth="2.5" />
                    <circle
                      cx="33" cy="33" r="30" fill="none"
                      stroke={color}
                      strokeWidth="2.5"
                      strokeDasharray={circumference}
                      strokeDashoffset={allViewed ? 0 : circumference * fraction}
                      strokeLinecap="round"
                      style={{ transition: "stroke-dashoffset 1s linear, stroke 0.3s ease" }}
                    />
                  </svg>
                  <img
                    className="sc-thumb"
                    src={newest.image}
                    alt={`${group.authorName} preview`}
                    style={{ opacity: allViewed ? 0.72 : 1 }}
                  />
                  {withPlusBadge && (
                    <button
                      className="sc-plus-badge"
                      aria-label="Add to your story"
                      onClick={(e) => {
                        e.stopPropagation();
                        openAddMenu();
                      }}
                    >
                      <Plus size={12} strokeWidth={3} />
                    </button>
                  )}
                  {withPlusBadge && uploadingCount > 0 && (
                    <div className="sc-upload-spinner" aria-label="Uploading">
                      <Loader2 size={20} className="sc-spin" />
                    </div>
                  )}
                </div>
                <span className="sc-label">
                  {group.stories.length > 1 ? `${group.authorName} · ${group.stories.length}` : group.authorName}
                </span>
                <span className="sc-sublabel">{formatRemaining(remaining)}</span>
              </div>
            );
          };

          return (
            <>
              <div className="sc-item sc-add-menu-wrap" ref={addMenuRef}>
                {myGroup ? (
                  renderGroupCircle(myGroup, { withPlusBadge: true })
                ) : (
                  <>
                    <div className="sc-avatar-wrap" style={{ position: "relative" }}>
                      <button
                        className="sc-add-btn"
                        onClick={openAddMenu}
                        aria-label="Add a story"
                        aria-haspopup="true"
                        aria-expanded={addMenuOpen}
                      >
                        {uploadingCount > 0 ? <Loader2 size={20} className="sc-spin" /> : <Plus size={22} />}
                      </button>
                    </div>
                    <span className="sc-label">{activeProfile.name}</span>
                  </>
                )}

                {addMenuOpen && (
                  <div className="sc-add-menu">
                    <button
                      className="sc-add-menu-item"
                      onClick={() => {
                        setAddMenuOpen(false);
                        cameraInputRef.current?.click();
                      }}
                    >
                      <Camera size={15} /> Take photo
                    </button>
                    <button
                      className="sc-add-menu-item"
                      onClick={() => {
                        setAddMenuOpen(false);
                        fileInputRef.current?.click();
                      }}
                    >
                      <Upload size={15} /> Choose from gallery
                    </button>
                  </div>
                )}
              </div>

              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                multiple
                style={{ display: "none" }}
                onChange={onPickFile}
              />
              <input
                ref={cameraInputRef}
                type="file"
                accept="image/*"
                capture="environment"
                style={{ display: "none" }}
                onChange={onCameraCapture}
              />

              {otherGroups.map((g) => renderGroupCircle(g))}
            </>
          );
        })()}
      </div>

      {visibleStories.length === 0 && (
        <div className="sc-empty-hint">No stories yet — tap + to post one. It'll disappear in 24 hours.</div>
      )}
      <div className="sc-hint-row">You can also drag images in, or paste from your clipboard.</div>
      {error && <div className="sc-error">{error}</div>}

      <div className="sc-storage-meter-wrap">
        <div className="sc-storage-meter">
          <div
            className="sc-storage-meter-fill"
            style={{
              width: `${storagePercent}%`,
              background: storagePercent > 85 ? "#ff6b4a" : storagePercent > 60 ? "#ffb84d" : "#3a4152",
            }}
          />
        </div>
        <div className="sc-storage-label">
          {formatBytes(storageUsageBytes)} used (rough estimate) · browsers typically allow ~5–10MB
        </div>
      </div>

      {toast && (
        <div className="sc-toast" role="status">
          <span>{toast.label}</span>
          <button className="sc-toast-undo" onClick={() => undoDelete(toast.id)}>Undo</button>
        </div>
      )}

      {viewerReel && (
        <StoryViewer
          stories={viewerReel.stories}
          startIndex={viewerReel.startIndex}
          now={now}
          onClose={() => setViewerReel(null)}
          onDelete={deleteStory}
          onView={markViewed}
        />
      )}
    </div>
  );
}

function StoryViewer({ stories, startIndex, now, onClose, onDelete, onView }) {
  const [index, setIndex] = useState(startIndex);
  const [progress, setProgress] = useState(0); // 0..1 for current story
  const [paused, setPaused] = useState(false);
  const rafRef = useRef(null);
  const startTimeRef = useRef(null);
  const pausedAccumRef = useRef(0);
  const touchRef = useRef(null);
  const frameRef = useRef(null);

  const current = stories[index];

  const downloadStory = () => {
    if (!current?.image) return;
    const a = document.createElement("a");
    a.href = current.image;
    a.download = `story-${current.id}.jpg`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  const goNext = useCallback(() => {
    setIndex((i) => {
      if (i >= stories.length - 1) {
        onClose();
        return i;
      }
      return i + 1;
    });
  }, [stories.length, onClose]);

  const goPrev = useCallback(() => {
    setIndex((i) => Math.max(0, i - 1));
  }, []);

  // reset progress whenever the active story changes, and mark it viewed
  useEffect(() => {
    setProgress(0);
    startTimeRef.current = performance.now();
    pausedAccumRef.current = 0;
    const s = stories[index];
    if (s) onView?.(s.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index]);

  useEffect(() => {
    function tick(t) {
      if (!paused) {
        const elapsed = t - startTimeRef.current - pausedAccumRef.current;
        const p = Math.min(1, elapsed / SLIDE_MS);
        setProgress(p);
        if (p >= 1) {
          goNext();
          return;
        }
      }
      rafRef.current = requestAnimationFrame(tick);
    }
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, paused, goNext]);

  const pauseTimer = () => setPaused(true);
  const resumeTimer = () => {
    setPaused(false);
    startTimeRef.current = performance.now() - (progress * SLIDE_MS);
    pausedAccumRef.current = 0;
  };

  const onTouchStart = (e) => {
    const t = e.touches[0];
    touchRef.current = { x: t.clientX, y: t.clientY, time: Date.now() };
    pauseTimer();
  };
  const onTouchEnd = (e) => {
    const start = touchRef.current;
    resumeTimer();
    if (!start) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - start.x;
    const dy = t.clientY - start.y;
    const dt = Date.now() - start.time;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy)) {
      if (dx > 0) goPrev(); else goNext();
    } else if (dt < 300 && Math.abs(dx) < 10) {
      const frameWidth = e.currentTarget.getBoundingClientRect().width;
      if (t.clientX - e.currentTarget.getBoundingClientRect().left < frameWidth / 2) goPrev();
      else goNext();
    }
    touchRef.current = null;
  };

  useEffect(() => {
    const previouslyFocused = document.activeElement;
    const focusFrame = requestAnimationFrame(() => {
      const firstBtn = frameRef.current?.querySelector(".sc-icon-btn, button");
      firstBtn?.focus();
    });

    function getFocusable() {
      if (!frameRef.current) return [];
      return Array.from(
        frameRef.current.querySelectorAll('button, [href], input, [tabindex]:not([tabindex="-1"])')
      ).filter((el) => !el.disabled && el.offsetParent !== null);
    }

    function onKey(e) {
      if (e.key === "ArrowRight") goNext();
      if (e.key === "ArrowLeft") goPrev();
      if (e.key === "Escape") onClose();
      if (e.key === "Tab") {
        const focusable = getFocusable();
        if (!focusable.length) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    }
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      cancelAnimationFrame(focusFrame);
      if (previouslyFocused && typeof previouslyFocused.focus === "function") {
        previouslyFocused.focus();
      }
    };
  }, [goNext, goPrev, onClose]);

  if (!current) return null;
  const remaining = LIFETIME_MS - (now - current.createdAt);

  return (
    <div className="sc-viewer-overlay" role="dialog" aria-modal="true">
      <div
        className="sc-viewer-frame"
        ref={frameRef}
        onTouchStart={onTouchStart}
        onTouchEnd={onTouchEnd}
        onMouseDown={pauseTimer}
        onMouseUp={resumeTimer}
      >
        <div className="sc-bars">
          {stories.map((s, i) => (
            <div className="sc-bar-track" key={s.id}>
              <div
                className="sc-bar-fill"
                style={{
                  width: i < index ? "100%" : i === index ? `${progress * 100}%` : "0%",
                  transition: i === index ? "none" : "width 0.2s",
                }}
              />
            </div>
          ))}
        </div>

        <div className="sc-viewer-top">
          <span className="sc-viewer-meta">{formatRemaining(remaining)}</span>
          <div className="sc-viewer-actions">
            <button className="sc-icon-btn" aria-label="Download story" onClick={downloadStory}>
              <Download size={14} />
            </button>
            <button className="sc-icon-btn" aria-label="Delete story" onClick={() => onDelete(current.id)}>
              <Trash2 size={15} />
            </button>
            <button className="sc-icon-btn" aria-label="Close" onClick={onClose}>
              <X size={17} />
            </button>
          </div>
        </div>

        {current.image ? (
          <img className="sc-viewer-img" src={current.image} alt="Story" />
        ) : (
          <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "#666" }}>
            <ImageOff size={40} />
          </div>
        )}

        <button className="sc-nav-zone left" onClick={goPrev} aria-label="Previous story">
          <ChevronLeft size={28} />
        </button>
        <button className="sc-nav-zone right" onClick={goNext} aria-label="Next story">
          <ChevronRight size={28} />
        </button>
        <div className="sc-touch-zone left" />
        <div className="sc-touch-zone right" />
      </div>
    </div>
  );
}