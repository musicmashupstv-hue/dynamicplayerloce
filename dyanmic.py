#!/usr/bin/env python3
"""
Dynamic Desktop Video Player
Reads a playlist file (JSON, M3U, or plain URL list) or fetches from an API.
Double‑click a stream to play.
"""

import tkinter as tk
from tkinter import ttk, messagebox
import vlc
import json
import requests
import os
import threading
import time
from urllib.parse import urlparse

# --- Configuration ---
PLAYLIST_SOURCE = "streams.json"   # Can be local file, .m3u, .txt, or http(s)://...
REFRESH_INTERVAL = 300000          # milliseconds (300s = 5min), 0 to disable

class StreamPlayer:
    def __init__(self, root):
        self.root = root
        self.root.title("Dynamic Stream Player")
        self.root.geometry("900x600")
        self.root.configure(bg='#2e2e2e')

        # VLC instance
        self.instance = vlc.Instance()
        self.player = self.instance.media_player_new()
        self.current_stream = None

        # UI
        self.create_widgets()
        
        # Load streams
        self.streams = []
        self.refresh_job = None
        self.load_streams()

    def create_widgets(self):
        # Left frame: playlist
        left_frame = tk.Frame(self.root, bg='#1e1e1e', width=250)
        left_frame.pack(side=tk.LEFT, fill=tk.Y, padx=(5,0), pady=5)
        left_frame.pack_propagate(False)

        tk.Label(left_frame, text="Channels", fg='white', bg='#1e1e1e', 
                 font=('Arial', 12, 'bold')).pack(pady=5)

        # Listbox with scrollbar
        list_frame = tk.Frame(left_frame, bg='#1e1e1e')
        list_frame.pack(fill=tk.BOTH, expand=True, padx=5, pady=5)

        self.listbox = tk.Listbox(list_frame, bg='#3c3c3c', fg='white', 
                                  selectbackground='#007acc', font=('Arial', 10))
        self.listbox.pack(side=tk.LEFT, fill=tk.BOTH, expand=True)

        scrollbar = tk.Scrollbar(list_frame, orient=tk.VERTICAL, command=self.listbox.yview)
        scrollbar.pack(side=tk.RIGHT, fill=tk.Y)
        self.listbox.config(yscrollcommand=scrollbar.set)

        self.listbox.bind('<Double-Button-1>', self.on_select)

        # Refresh button
        tk.Button(left_frame, text="Refresh Playlist", command=self.load_streams,
                  bg='#007acc', fg='white').pack(pady=5, fill=tk.X, padx=10)

        # Right frame: video
        right_frame = tk.Frame(self.root, bg='black')
        right_frame.pack(side=tk.RIGHT, fill=tk.BOTH, expand=True, padx=(0,5), pady=5)

        self.video_frame = tk.Frame(right_frame, bg='black')
        self.video_frame.pack(fill=tk.BOTH, expand=True)

        # Control buttons
        control_frame = tk.Frame(right_frame, bg='#2e2e2e')
        control_frame.pack(fill=tk.X, pady=5)

        self.play_btn = tk.Button(control_frame, text="▶ Play", command=self.play,
                                  bg='#007acc', fg='white', state=tk.DISABLED)
        self.play_btn.pack(side=tk.LEFT, padx=2)

        self.pause_btn = tk.Button(control_frame, text="⏸ Pause", command=self.pause,
                                   bg='#555', fg='white', state=tk.DISABLED)
        self.pause_btn.pack(side=tk.LEFT, padx=2)

        self.stop_btn = tk.Button(control_frame, text="⏹ Stop", command=self.stop,
                                  bg='#555', fg='white', state=tk.DISABLED)
        self.stop_btn.pack(side=tk.LEFT, padx=2)

        # Volume
        tk.Label(control_frame, text="Volume:", fg='white', bg='#2e2e2e').pack(side=tk.LEFT, padx=(10,0))
        self.volume_scale = tk.Scale(control_frame, from_=0, to=100, orient=tk.HORIZONTAL,
                                     command=self.set_volume, bg='#2e2e2e', fg='white',
                                     highlightbackground='#2e2e2e', length=120)
        self.volume_scale.set(70)
        self.volume_scale.pack(side=tk.LEFT, padx=5)

        # Status bar
        self.status = tk.Label(self.root, text="Ready", bd=1, relief=tk.SUNKEN, 
                               anchor=tk.W, bg='#1e1e1e', fg='white')
        self.status.pack(side=tk.BOTTOM, fill=tk.X)

        # Embed VLC after UI is drawn
        self.root.update()
        self.player.set_hwnd(self.video_frame.winfo_id())

    def set_volume(self, val):
        self.player.audio_set_volume(int(val))

    def load_streams(self):
        """Fetch playlist from file or URL."""
        self.status.config(text="Loading playlist...")
        threading.Thread(target=self._load_streams_thread, daemon=True).start()

    def _load_streams_thread(self):
        try:
            if PLAYLIST_SOURCE.startswith(('http://', 'https://')):
                # Fetch from API
                resp = requests.get(PLAYLIST_SOURCE, timeout=10)
                data = resp.json()
                new_streams = data.get('streams', [])
            else:
                # Local file
                ext = os.path.splitext(PLAYLIST_SOURCE)[1].lower()
                if ext == '.json':
                    with open(PLAYLIST_SOURCE, 'r') as f:
                        data = json.load(f)
                    new_streams = data.get('streams', [])
                elif ext in ('.m3u', '.m3u8'):
                    new_streams = self.parse_m3u(PLAYLIST_SOURCE)
                elif ext == '.txt':
                    with open(PLAYLIST_SOURCE, 'r') as f:
                        lines = [l.strip() for l in f if l.strip()]
                    new_streams = [{'name': f'Stream {i+1}', 'url': line} 
                                   for i, line in enumerate(lines)]
                else:
                    messagebox.showerror("Error", f"Unsupported playlist format: {ext}")
                    return

            self.streams = new_streams
            self.root.after(0, self.update_listbox)

        except Exception as e:
            self.root.after(0, lambda: messagebox.showerror("Error", f"Failed to load playlist: {e}"))

        finally:
            self.root.after(0, lambda: self.status.config(text="Playlist loaded"))
            # Schedule next refresh
            if REFRESH_INTERVAL > 0:
                self.root.after(REFRESH_INTERVAL, self.load_streams)

    def parse_m3u(self, filepath):
        """Basic M3U parser."""
        streams = []
        with open(filepath, 'r', encoding='utf-8') as f:
            lines = f.readlines()
        name = None
        for line in lines:
            line = line.strip()
            if line.startswith('#EXTINF:'):
                # Extract name after comma
                parts = line.split(',', 1)
                name = parts[1] if len(parts) > 1 else None
            elif line and not line.startswith('#'):
                url = line
                streams.append({'name': name or url, 'url': url})
                name = None
        return streams

    def update_listbox(self):
        self.listbox.delete(0, tk.END)
        for s in self.streams:
            self.listbox.insert(tk.END, s.get('name', s['url']))

    def on_select(self, event=None):
        selection = self.listbox.curselection()
        if selection:
            idx = selection[0]
            self.current_stream = self.streams[idx]
            self.status.config(text=f"Selected: {self.current_stream['name']}")
            self.play_btn.config(state=tk.NORMAL)
            self.stop_btn.config(state=tk.NORMAL)
            # Auto-play on double-click
            self.play()

    def play(self):
        if not self.current_stream:
            return
        url = self.current_stream['url']
        auth = self.current_stream.get('auth', {})
        headers = auth.get('headers', {})
        if auth.get('token'):
            headers['Authorization'] = f"Bearer {auth['token']}"

        # Build media options
        options = []
        if headers:
            header_str = "\r\n".join(f"{k}: {v}" for k, v in headers.items())
            options.append(f":http-headers={header_str}")
        if auth.get('cookies_file'):
            options.append(f":http-cookies={auth['cookies_file']}")

        media = self.instance.media_new(url, *options)
        self.player.set_media(media)
        self.player.play()
        self.status.config(text=f"Playing: {self.current_stream['name']}")
        self.play_btn.config(state=tk.DISABLED)
        self.pause_btn.config(state=tk.NORMAL)
        self.stop_btn.config(state=tk.NORMAL)

    def pause(self):
        self.player.pause()
        state = "Paused" if self.player.get_state() == vlc.State.Paused else "Playing"
        self.status.config(text=state)

    def stop(self):
        self.player.stop()
        self.status.config(text="Stopped")
        self.play_btn.config(state=tk.NORMAL)
        self.pause_btn.config(state=tk.DISABLED)

    def on_closing(self):
        self.player.stop()
        self.root.destroy()

if __name__ == "__main__":
    root = tk.Tk()
    app = StreamPlayer(root)
    root.protocol("WM_DELETE_WINDOW", app.on_closing)
    root.mainloop()
