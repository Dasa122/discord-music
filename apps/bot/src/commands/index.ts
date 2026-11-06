import { clearCommand } from "./clear.js";
import { disconnectCommand } from "./disconnect.js";
import { historyCommand } from "./history.js";
import { loopCommand } from "./loop.js";
import { moveCommand } from "./move.js";
import { nowPlayingCommand } from "./nowplaying.js";
import { pauseCommand } from "./pause.js";
import { playCommand } from "./play.js";
import { playlistCommand } from "./playlist.js";
import { queueCommand } from "./queue.js";
import { removeCommand } from "./remove.js";
import { resumeCommand } from "./resume.js";
import { searchCommand } from "./search.js";
import { seekCommand } from "./seek.js";
import { shuffleCommand } from "./shuffle.js";
import { skipCommand } from "./skip.js";
import { stopCommand } from "./stop.js";
import type { Command } from "./types.js";
import { volumeCommand } from "./volume.js";

export const commands: Command[] = [
  playCommand,
  searchCommand,
  skipCommand,
  pauseCommand,
  resumeCommand,
  stopCommand,
  nowPlayingCommand,
  queueCommand,
  volumeCommand,
  seekCommand,
  loopCommand,
  shuffleCommand,
  removeCommand,
  moveCommand,
  clearCommand,
  disconnectCommand,
  playlistCommand,
  historyCommand,
];

export const commandByName = new Map<string, Command>(
  commands.map((command) => [command.data.name, command]),
);
