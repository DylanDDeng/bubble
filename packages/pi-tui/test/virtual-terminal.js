import xterm from "@xterm/headless";
// Extract Terminal class from the module
const XtermTerminal = xterm.Terminal;
/**
 * Virtual terminal for testing using xterm.js for accurate terminal emulation
 */
export class VirtualTerminal {
    constructor(columns = 80, rows = 24) {
        this._columns = columns;
        this._rows = rows;
        // Create xterm instance with specified dimensions
        this.xterm = new XtermTerminal({
            cols: columns,
            rows: rows,
            // Disable all interactive features for testing
            disableStdin: true,
            allowProposedApi: true,
        });
    }
    start(onInput, onResize) {
        this.inputHandler = onInput;
        this.resizeHandler = onResize;
        // Enable bracketed paste mode for consistency with ProcessTerminal
        this.xterm.write("\x1b[?2004h");
    }
    async drainInput(_maxMs, _idleMs) {
        // No-op for virtual terminal - no stdin to drain
    }
    stop() {
        // Disable bracketed paste mode
        this.xterm.write("\x1b[?2004l");
        this.inputHandler = undefined;
        this.resizeHandler = undefined;
    }
    write(data) {
        this.xterm.write(data);
    }
    get columns() {
        return this._columns;
    }
    get rows() {
        return this._rows;
    }
    get kittyProtocolActive() {
        // Virtual terminal always reports Kitty protocol as active for testing
        return true;
    }
    moveBy(lines) {
        if (lines > 0) {
            // Move down
            this.xterm.write(`\x1b[${lines}B`);
        }
        else if (lines < 0) {
            // Move up
            this.xterm.write(`\x1b[${-lines}A`);
        }
        // lines === 0: no movement
    }
    hideCursor() {
        this.xterm.write("\x1b[?25l");
    }
    showCursor() {
        this.xterm.write("\x1b[?25h");
    }
    clearLine() {
        this.xterm.write("\x1b[K");
    }
    clearFromCursor() {
        this.xterm.write("\x1b[J");
    }
    clearScreen() {
        this.xterm.write("\x1b[2J\x1b[H"); // Clear screen and move to home (1,1)
    }
    setTitle(title) {
        // OSC 0;title BEL - set terminal window title
        this.xterm.write(`\x1b]0;${title}\x07`);
    }
    setProgress(_active) { }
    // Test-specific methods not in Terminal interface
    /**
     * Simulate keyboard input
     */
    sendInput(data) {
        if (this.inputHandler) {
            this.inputHandler(data);
        }
    }
    /**
     * Resize the terminal
     */
    resize(columns, rows) {
        this._columns = columns;
        this._rows = rows;
        this.xterm.resize(columns, rows);
        if (this.resizeHandler) {
            this.resizeHandler();
        }
    }
    /**
     * Wait for all pending writes to complete. Viewport and scroll buffer will be updated.
     */
    async flush() {
        // Write an empty string to ensure all previous writes are flushed
        return new Promise((resolve) => {
            this.xterm.write("", () => resolve());
        });
    }
    /**
     * Flush and get viewport - convenience method for tests
     */
    async flushAndGetViewport() {
        await this.flush();
        return this.getViewport();
    }
    /**
     * Get the visible viewport (what's currently on screen)
     * Note: You should use getViewportAfterWrite() for testing after writing data
     */
    getViewport() {
        const lines = [];
        const buffer = this.xterm.buffer.active;
        // Get only the visible lines (viewport)
        for (let i = 0; i < this.xterm.rows; i++) {
            const line = buffer.getLine(buffer.viewportY + i);
            if (line) {
                lines.push(line.translateToString(true));
            }
            else {
                lines.push("");
            }
        }
        return lines;
    }
    /**
     * Get the entire scroll buffer
     */
    getScrollBuffer() {
        const lines = [];
        const buffer = this.xterm.buffer.active;
        // Get all lines in the buffer (including scrollback)
        for (let i = 0; i < buffer.length; i++) {
            const line = buffer.getLine(i);
            if (line) {
                lines.push(line.translateToString(true));
            }
            else {
                lines.push("");
            }
        }
        return lines;
    }
    /**
     * Clear the terminal viewport
     */
    clear() {
        this.xterm.clear();
    }
    /**
     * Reset the terminal completely
     */
    reset() {
        this.xterm.reset();
    }
    /**
     * Get cursor position
     */
    getCursorPosition() {
        const buffer = this.xterm.buffer.active;
        return {
            x: buffer.cursorX,
            y: buffer.cursorY,
        };
    }
    /** Wait for TUI's throttled render pipeline to settle. */
    async waitForRender() {
        await new Promise((resolve) => process.nextTick(resolve));
        await new Promise((resolve) => setTimeout(resolve, 20));
        await this.flush();
    }
}
//# sourceMappingURL=virtual-terminal.js.map