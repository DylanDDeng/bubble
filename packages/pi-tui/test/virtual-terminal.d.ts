import type { Terminal } from "../src/terminal.ts";
/**
 * Virtual terminal for testing using xterm.js for accurate terminal emulation
 */
export declare class VirtualTerminal implements Terminal {
    private xterm;
    private inputHandler?;
    private resizeHandler?;
    private _columns;
    private _rows;
    constructor(columns?: number, rows?: number);
    start(onInput: (data: string) => void, onResize: () => void): void;
    drainInput(_maxMs?: number, _idleMs?: number): Promise<void>;
    stop(): void;
    write(data: string): void;
    get columns(): number;
    get rows(): number;
    get kittyProtocolActive(): boolean;
    moveBy(lines: number): void;
    hideCursor(): void;
    showCursor(): void;
    clearLine(): void;
    clearFromCursor(): void;
    clearScreen(): void;
    setTitle(title: string): void;
    setProgress(_active: boolean): void;
    /**
     * Simulate keyboard input
     */
    sendInput(data: string): void;
    /**
     * Resize the terminal
     */
    resize(columns: number, rows: number): void;
    /**
     * Wait for all pending writes to complete. Viewport and scroll buffer will be updated.
     */
    flush(): Promise<void>;
    /**
     * Flush and get viewport - convenience method for tests
     */
    flushAndGetViewport(): Promise<string[]>;
    /**
     * Get the visible viewport (what's currently on screen)
     * Note: You should use getViewportAfterWrite() for testing after writing data
     */
    getViewport(): string[];
    /**
     * Get the entire scroll buffer
     */
    getScrollBuffer(): string[];
    /**
     * Clear the terminal viewport
     */
    clear(): void;
    /**
     * Reset the terminal completely
     */
    reset(): void;
    /**
     * Get cursor position
     */
    getCursorPosition(): {
        x: number;
        y: number;
    };
    /** Wait for TUI's throttled render pipeline to settle. */
    waitForRender(): Promise<void>;
}
//# sourceMappingURL=virtual-terminal.d.ts.map