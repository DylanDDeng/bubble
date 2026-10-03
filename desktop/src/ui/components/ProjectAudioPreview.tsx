import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { toast } from 'sonner';
import { Copy, Download, MoreHorizontal, PauseFilled, PlayFilled } from './icons';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from './ui/dropdown-menu';

const AUDIO_FORMAT_LABELS: Record<string, string> = {
  '.mp3': 'MP3 audio',
  '.wav': 'WAV audio',
  '.m4a': 'M4A audio',
  '.aac': 'AAC audio',
  '.ogg': 'Ogg audio',
  '.oga': 'Ogg audio',
  '.opus': 'Opus audio',
  '.flac': 'FLAC audio',
};

function formatAudioTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const total = Math.floor(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = String(total % 60).padStart(2, '0');
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${secs}` : `${minutes}:${secs}`;
}

function WaveformGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" aria-hidden="true">
      <path d="M3 10v4M7.5 7v10M12 3.5v17M16.5 7v10M21 10v4" />
    </svg>
  );
}

export function ProjectAudioPreview({
  src,
  cwd,
  path,
  name,
  ext,
  active,
}: {
  src: string;
  cwd: string | null;
  path: string;
  name: string;
  ext: string;
  active: boolean;
}) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!active) audioRef.current?.pause();
  }, [active]);

  const togglePlayback = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) {
      void audio.play().catch(() => setFailed(true));
    } else {
      audio.pause();
    }
  };

  const copyPath = async () => {
    try {
      await navigator.clipboard.writeText(path);
      toast.success('Path copied.');
    } catch {
      toast.error('Unable to copy the path.');
    }
  };

  const saveCopy = async () => {
    if (!cwd) return;
    try {
      const result = await window.electron.saveProjectFileCopy(cwd, path);
      if (result.ok) toast.success('Copy saved.');
      else if (!result.canceled) toast.error(result.message || 'Failed to save a copy.');
    } catch (error) {
      toast.error(`Failed to save a copy: ${String(error)}`);
    }
  };

  const seekTo = (seconds: number) => {
    const audio = audioRef.current;
    if (!audio || !Number.isFinite(seconds)) return;
    audio.currentTime = seconds;
    setCurrentTime(seconds);
  };

  const hasDuration = Number.isFinite(duration) && duration > 0;
  const progress = hasDuration ? Math.min(100, (currentTime / duration) * 100) : 0;
  const formatLabel = AUDIO_FORMAT_LABELS[ext] ?? `${ext.replace(/^\./, '').toUpperCase() || 'Audio'} audio`;

  return (
    <div className="flex w-full max-w-[860px] flex-col gap-3">
      <div
        className="w-full overflow-hidden rounded-[14px] border border-[var(--border)] bg-[var(--bg-secondary)]"
        data-testid="project-audio-preview"
      >
        <div className="flex items-center gap-3 px-3 py-3">
          <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-[10px] bg-[var(--bg-tertiary)] text-[var(--accent)]">
            <WaveformGlyph className="h-6 w-6" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-[15px] font-medium text-[var(--text-primary)]" title={name}>
              {name}
            </div>
            <div className="mt-0.5 text-[13px] text-[var(--text-muted)]">{formatLabel}</div>
          </div>
          <button
            type="button"
            onClick={togglePlayback}
            disabled={failed}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[var(--bg-tertiary)] text-[var(--text-primary)] transition-colors hover:bg-[var(--border)] disabled:opacity-40"
            aria-label={playing ? 'Pause' : 'Play'}
            title={playing ? 'Pause' : 'Play'}
          >
            {playing ? <PauseFilled className="h-4 w-4" /> : <PlayFilled className="h-4 w-4" />}
          </button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]"
                aria-label="More actions"
                title="More actions"
              >
                <MoreHorizontal className="h-[18px] w-[18px]" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" sideOffset={6} className="min-w-[10.5rem] p-1">
              <DropdownMenuItem onSelect={() => void copyPath()} className="rounded-md px-2 py-1.5 text-[13px]">
                <Copy className="mr-2.5 h-4 w-4 flex-shrink-0 text-[var(--text-secondary)]" aria-hidden="true" />
                <span>Copy path</span>
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => void saveCopy()}
                disabled={!cwd}
                className="rounded-md px-2 py-1.5 text-[13px]"
              >
                <Download className="mr-2.5 h-4 w-4 flex-shrink-0 text-[var(--text-secondary)]" aria-hidden="true" />
                <span>Save a copy…</span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        <div className="flex items-center gap-4 border-t border-[var(--border)] px-4 py-3">
          <input
            type="range"
            className="project-audio-seek min-w-0 flex-1"
            min={0}
            max={hasDuration ? duration : 0}
            step="any"
            value={hasDuration ? Math.min(currentTime, duration) : 0}
            disabled={!hasDuration || failed}
            onChange={(event) => seekTo(Number(event.target.value))}
            aria-label="Seek"
            aria-valuetext={`${formatAudioTime(currentTime)} of ${formatAudioTime(duration)}`}
            style={{ '--project-audio-progress': `${progress}%` } as CSSProperties}
          />
          <span className="shrink-0 text-[13px] tabular-nums text-[var(--text-muted)]">
            {formatAudioTime(currentTime)} / {formatAudioTime(duration)}
          </span>
        </div>
      </div>
      <audio
        ref={audioRef}
        src={src}
        aria-label={name}
        preload="metadata"
        onLoadStart={() => {
          setFailed(false);
          setPlaying(false);
          setCurrentTime(0);
          setDuration(0);
        }}
        onLoadedMetadata={(event) => setDuration(event.currentTarget.duration)}
        onDurationChange={(event) => setDuration(event.currentTarget.duration)}
        onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
        onError={() => {
          setFailed(true);
          setPlaying(false);
        }}
        className="hidden"
      />
      {failed && (
        <p role="alert" className="text-sm text-[var(--text-muted)]">
          Unable to load or decode this audio. Try opening it in your system player.
        </p>
      )}
    </div>
  );
}
