#!/bin/bash

# Clips the link on the clipboard into Obsidian through Oriko, leaving
# Obsidian in the background. Bind it to a key with whatever launcher you
# already run: Raycast, Alfred, Hammerspoon, skhd, or a Shortcuts "Run Shell
# Script" action. The Raycast header below is ignored by everything else.
#
# The plugin's actual contract is the url this ends on:
#     obsidian://oriko?url=<percent-encoded page url>
# Anything that can open that url can clip. This script is one way, not the way.

# @raycast.schemaVersion 1
# @raycast.title Clip to Oriko
# @raycast.mode compact
# @raycast.packageName Obsidian
# @raycast.icon 🖼
# @raycast.description Clip the link on the clipboard into Obsidian.

# Every binary is called by absolute path. A GUI launcher hands the script a
# PATH of its own choosing, and a bare command that is not found would kill the
# script before it could print why.
LOG=/tmp/oriko-clip.log
exec 2>>"$LOG"
echo "--- $(/bin/date '+%F %T') pid=$$" >>"$LOG"

# Every exit is 0. Raycast shows the output of a script that succeeded and
# replaces a failed one with "failed to run", throwing the diagnosis away.
say() { echo "$1"; echo "RESULT: $1" >>"$LOG"; exit 0; }

clipboard=$(/usr/bin/pbpaste 2>/dev/null)
[ -n "$clipboard" ] || say "Clipboard is empty."

# The first web link in whatever was copied. Copying from a page usually brings
# prose along with the link, and Oriko digs the url out of that anyway, but
# pulling it out here lets this script say exactly what it sent.
url=$(printf '%s' "$clipboard" | /usr/bin/grep -oE 'https?://[^[:space:]<>"]+' | /usr/bin/head -1)
echo "url: [$url]" >>"$LOG"
[ -n "$url" ] || say "No link on the clipboard: ${clipboard:0:40}"

encoded=$(printf '%s' "$url" | /usr/bin/python3 -c 'import sys,urllib.parse; sys.stdout.write(urllib.parse.quote(sys.stdin.read(), safe=""))')
[ -n "$encoded" ] || say "Could not encode the url."

# -g keeps Obsidian off the foreground: the clip happens behind whatever you
# are looking at.
/usr/bin/open -g "obsidian://oriko?url=$encoded"
echo "open exit: $?" >>"$LOG"

say "Clipped ${url:0:50}"
