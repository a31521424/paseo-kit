// A minimal terminal screen: enough of VT100 to replay what Claude Code's interactive UI draws
// (cursor moves, line and screen erases, scrolling) and read the final screen as text. Colors,
// modes and other sequences are ignored.

export class Screen {
  private grid: string[][];
  private row = 0;
  private col = 0;
  private saved = { row: 0, col: 0 };
  private pending = "";

  readonly rows: number;
  readonly cols: number;

  constructor(rows: number, cols: number) {
    this.rows = rows;
    this.cols = cols;
    this.grid = Array.from({ length: rows }, () => this.blankRow());
  }

  private blankRow(): string[] {
    return Array.from({ length: this.cols }, () => " ");
  }

  private clamp() {
    this.row = Math.min(Math.max(this.row, 0), this.rows - 1);
    this.col = Math.min(Math.max(this.col, 0), this.cols - 1);
  }

  private lineFeed() {
    if (this.row === this.rows - 1) {
      this.grid.shift();
      this.grid.push(this.blankRow());
    } else {
      this.row += 1;
    }
  }

  private eraseLine(mode: number) {
    const line = this.grid[this.row];
    if (!line) return;
    const [from, to] =
      mode === 0 ? [this.col, this.cols] : mode === 1 ? [0, this.col + 1] : [0, this.cols];
    for (let index = from; index < to; index += 1) line[index] = " ";
  }

  private eraseDisplay(mode: number) {
    if (mode === 2 || mode === 3) {
      this.grid = Array.from({ length: this.rows }, () => this.blankRow());
      return;
    }
    const rows = mode === 0 ? [this.row + 1, this.rows] : [0, this.row];
    for (let index = rows[0]!; index < rows[1]!; index += 1) this.grid[index] = this.blankRow();
    this.eraseLine(mode);
  }

  private csi(params: string, final: string) {
    const isPrivate = params.startsWith("?");
    const values = (isPrivate ? params.slice(1) : params)
      .split(";")
      .map((value) => Number(value) || 0);
    const n = Math.max(values[0] ?? 0, 1);
    if (isPrivate) {
      // Entering or leaving the alternate screen starts from a blank screen.
      if ((final === "h" || final === "l") && values.includes(1049)) this.eraseDisplay(2);
      return;
    }
    switch (final) {
      case "A":
        this.row -= n;
        break;
      case "B":
      case "e":
        this.row += n;
        break;
      case "C":
      case "a":
        this.col += n;
        break;
      case "D":
        this.col -= n;
        break;
      case "E":
        this.row += n;
        this.col = 0;
        break;
      case "F":
        this.row -= n;
        this.col = 0;
        break;
      case "G":
      case "`":
        this.col = n - 1;
        break;
      case "d":
        this.row = n - 1;
        break;
      case "H":
      case "f":
        this.row = Math.max(values[0] ?? 1, 1) - 1;
        this.col = Math.max(values[1] ?? 1, 1) - 1;
        break;
      case "J":
        this.eraseDisplay(values[0] ?? 0);
        break;
      case "K":
        this.eraseLine(values[0] ?? 0);
        break;
      case "X": {
        const line = this.grid[this.row];
        for (let index = this.col; line && index < Math.min(this.col + n, this.cols); index += 1) {
          line[index] = " ";
        }
        break;
      }
      case "s":
        this.saved = { row: this.row, col: this.col };
        break;
      case "u":
        ({ row: this.row, col: this.col } = this.saved);
        break;
      default:
        break;
    }
    this.clamp();
  }

  write(data: string) {
    const input = this.pending + data;
    this.pending = "";
    let index = 0;
    while (index < input.length) {
      const char = input[index]!;
      if (char === "\x1b") {
        const next = input[index + 1];
        if (next === undefined) {
          this.pending = input.slice(index);
          return;
        }
        if (next === "[") {
          const match = /^\x1b\[([0-9;?<>=!]*)[ -/]*([@-~])/.exec(input.slice(index));
          if (!match) {
            // An unfinished sequence waits for the next chunk; anything else is dropped.
            if (/^\x1b\[[0-9;?<>=! -/]*$/.test(input.slice(index)))
              this.pending = input.slice(index);
            return;
          }
          this.csi(match[1]!, match[2]!);
          index += match[0].length;
          continue;
        }
        if (next === "]" || next === "P" || next === "_" || next === "^") {
          // OSC and other strings end with BEL or ESC \.
          const rest = input.slice(index + 2);
          const end = rest.search(/\x07|\x1b\\/);
          if (end === -1) {
            this.pending = input.slice(index);
            return;
          }
          index += 2 + end + (rest[end] === "\x07" ? 1 : 2);
          continue;
        }
        if (next === "7") this.saved = { row: this.row, col: this.col };
        if (next === "8") ({ row: this.row, col: this.col } = this.saved);
        if (next === "M") {
          if (this.row === 0) {
            this.grid.pop();
            this.grid.unshift(this.blankRow());
          } else {
            this.row -= 1;
          }
        }
        // Character set selections carry one more byte.
        index += "()*+".includes(next) ? 3 : 2;
        continue;
      }
      if (char === "\r") this.col = 0;
      else if (char === "\n") this.lineFeed();
      else if (char === "\b") this.col = Math.max(this.col - 1, 0);
      else if (char === "\t")
        this.col = Math.min((Math.floor(this.col / 8) + 1) * 8, this.cols - 1);
      else if (char >= " " && char !== "\x7f") {
        if (this.col >= this.cols) {
          this.col = 0;
          this.lineFeed();
        }
        this.grid[this.row]![this.col] = char;
        this.col += 1;
      }
      index += 1;
    }
  }

  text(): string {
    return this.grid.map((line) => line.join("").trimEnd()).join("\n");
  }
}
