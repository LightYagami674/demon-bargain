# Demon Bargain

A real-time, mobile-first, 2–6 player multiplayer horror chat game where players plead for survival and betray each other while judged by an AI Entity.

## Language

**Room**:
An ephemeral lobby identified by a 4-letter code where 2–6 players gather and play one or more sequential Matches.
_Avoid_: Lobby, server, session

**Host**:
The player who created the Room and controls Match start, kicks before a Match begins, and rematches; transfers automatically to the longest-standing remaining player if they leave.
_Avoid_: Admin, owner, room leader

**Match**:
A single game played inside a Room across `n - 1` elimination rounds until one survivor remains.
_Avoid_: Game, round, run

**Entity**:
The in-universe demonic judge that shifts moods, mocks players, intercepts whispers, and claims one sacrifice per round.
_Avoid_: Bot, AI, Jev, demon

**Jev**:
The underlying `@typesafe-ai/sdk` evaluation engine that scores player messages, detects spam, picks intercepted whispers, and checks Ghost curses.
_Avoid_: Entity, LLM

**Doom Meter**:
A living player's 0%–100% peril gauge that rises or falls in real time based on Jev's judgments and determines who is sacrificed.
_Avoid_: Health, HP, threat, fear bar

**Entity Mood**:
The hidden judging lens (`SADIST`, `BLOODHOUND`, `MARTYR_TRAP`, `TYRANT`, `PARANOID`, or `TRICKSTER`) that rotates periodically and governs what kind of plea Jev rewards or punishes.
_Avoid_: Mode, state, phase

**Whisper**:
A private one-line message sent directly between two living players that risks being leaked publicly as an intercepted message.
_Avoid_: DM, PM, private chat

**Ghost**:
An eliminated player who can no longer plead for survival and instead casts Curses on living players.
_Avoid_: Dead player, spectator

**Curse**:
A mandatory word chosen by a Ghost and placed onto a living player's next public message, adding Doom if Jev judges they failed to include it naturally.
_Avoid_: Hex, debuff, penalty
