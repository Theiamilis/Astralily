import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { ArrowLeft, ChevronLeft, ChevronRight, Library, Palette, SendHorizontal, Settings2, VolumeX } from 'lucide-react';
import { AudioWaveform } from '../components/AudioWaveform';
import { FamilyMapPanel } from '../components/FamilyMapPanel';
import { HomePanel } from '../components/HomePanel';
import { OverviewComputers } from '../components/OverviewComputers';
import { changeDisplayVariant } from '../displayPreferences';
import { overviewReplyPages } from '../overviewConversation';
import { readOverviewTheme, saveOverviewTheme, type OverviewTheme } from '../overviewTheme';
import type { DashboardAudio } from '../useDashboardAudio';
import '../../styles/overview.css';

type Props = {
  apiBaseUrl: string; stage: ReactNode; audio: DashboardAudio;
  messages: { id: number; role: string; text: string; pending?: boolean }[];
  input: string; onInput: (value: string) => void; onSend: () => void;
  onStopVoice: () => void; sending: boolean;
  services: { label: string; state: string }[]; healthUpdatedAt: string;
  onSettings: () => void; onFamily: () => void; onModels: () => void; children?: ReactNode;
};

export function ControlCenterOverview(props: Props) {
  const [showLive2D, setShowLive2D] = useState(() => window.localStorage.getItem('lily_overview_live2d') === 'true');
  const [view, setView] = useState('family');
  const [narrow, setNarrow] = useState(() => window.matchMedia('(max-width: 879px)').matches);
  const [replyPage, setReplyPage] = useState(0);
  const [theme, setTheme] = useState<OverviewTheme>(readOverviewTheme);
  const replies = useMemo(() => props.messages.flatMap(message => overviewReplyPages(message.text, showLive2D ? 16 : 32).map(text => ({ ...message, text }))), [props.messages, showLive2D]);
  useEffect(() => {
    const latest = props.messages[props.messages.length - 1];
    setReplyPage(Math.max(0, replies.findIndex(reply => reply.id === latest?.id)));
  }, [replies]);
  useEffect(() => {
    const query = window.matchMedia('(max-width: 879px)');
    const changed = () => setNarrow(query.matches);
    query.addEventListener('change', changed);
    return () => query.removeEventListener('change', changed);
  }, []);
  useEffect(() => {
    const syncTheme = () => setTheme(readOverviewTheme());
    window.addEventListener('storage', syncTheme);
    return () => window.removeEventListener('storage', syncTheme);
  }, []);
  const page = Math.min(replyPage, Math.max(0, replies.length - 1));
  const reply = replies[page];
  const coreReachable = props.services.some(service => service.label === 'Core' && ['online', 'degraded'].includes(service.state));
  return <div className="lily-overview" data-theme={theme}>
    <div className="overview-shell">
      <header className="overview-header">
        <div className="overview-brand"><span>Lily</span><h1>Overview</h1></div>
        <section className="overview-service-strip" aria-label="Service status">{props.services.map(service => <div key={service.label} role="group" aria-label={`${service.label}: ${service.state}`}><span className={`overview-status-dot state-${service.state}`} /><span>{service.label}</span><strong>{service.state === 'loading' ? 'Checking' : service.state}</strong></div>)}<small>{props.healthUpdatedAt}</small></section>
        <div className="overview-actions">
          <label className="overview-theme-picker"><Palette size={15} aria-hidden="true" /><span className="overview-sr-only">Overview color theme</span><select aria-label="Overview color theme" value={theme} onChange={event => { const next = event.target.value as OverviewTheme; setTheme(next); saveOverviewTheme(next); }}><option value="rose">Rose</option><option value="classic">Lily Classic</option><option value="jarvis">Jarvis Blue</option></select></label>
          <button type="button" onClick={() => changeDisplayVariant('classic')}><ArrowLeft size={15} />Classic layout</button><button type="button" onClick={props.onSettings} aria-label="Settings"><Settings2 size={17} /><span>Settings</span></button>
        </div>
      </header>
      <nav className="overview-mobile-nav" aria-label="Overview sections">{[['family', 'Family'], ['home', 'Home & PC'], ['lily', 'Lily']].map(([id, label]) => <button key={id} type="button" aria-pressed={view === id} onClick={() => setView(id)}>{label}</button>)}</nav>
      <main className="overview-grid" data-view={view}>
        <FamilyMapPanel apiBaseUrl={props.apiBaseUrl} onManage={props.onFamily} theme={theme} />
        <div className="overview-operations">
          <section className="overview-panel overview-home"><HomePanel apiBaseUrl={props.apiBaseUrl} lightsOnly compact /></section>
          <OverviewComputers apiBaseUrl={props.apiBaseUrl} coreReachable={coreReachable} />
          <section className="overview-panel overview-companion" aria-labelledby="overview-lily-heading" data-live2d={showLive2D}>
            <header className="overview-section-heading"><h2 id="overview-lily-heading">Lily</h2><div><label className="overview-toggle"><input type="checkbox" checked={showLive2D} onChange={event => { setShowLive2D(event.target.checked); window.localStorage.setItem('lily_overview_live2d', String(event.target.checked)); }} />Live2D</label>{showLive2D ? <button type="button" aria-label="Model library" title="Model library" onClick={props.onModels}><Library size={16} /></button> : null}<button type="button" aria-label="Stop voice" title="Stop voice" onClick={props.onStopVoice}><VolumeX size={16} /></button></div></header>
            <div className="overview-companion-body">
              <div className="overview-presentation">{showLive2D ? (!narrow || view === 'lily' ? props.stage : null) : <AudioWaveform audio={props.audio} thinking={props.sending} theme={theme} />}</div>
              <div className="overview-conversation">
                <div className="overview-reply-nav"><strong>{reply?.role === 'owner' ? 'You' : 'Lily'}</strong><div><button type="button" aria-label="Previous reply page" disabled={page === 0} onClick={() => setReplyPage(page - 1)}><ChevronLeft size={15} /></button><span>{replies.length ? `${page + 1}/${replies.length}` : 'No messages'}</span><button type="button" aria-label="Next reply page" disabled={page + 1 >= replies.length} onClick={() => setReplyPage(page + 1)}><ChevronRight size={15} /></button></div></div>
                <p className="overview-reply-text" role="status" aria-busy={reply?.pending || undefined}>{reply?.text || 'Lily is ready.'}</p>
              </div>
              {showLive2D && props.audio.error ? <div className="overview-audio-retry"><span>{props.audio.error}</span><button type="button" onClick={props.audio.resume}>Play voice</button></div> : null}
              <form className="overview-chat-form" onSubmit={event => { event.preventDefault(); props.onSend(); }}><label htmlFor="overview-chat-input" className="overview-sr-only">Message Lily</label><input id="overview-chat-input" value={props.input} onChange={event => props.onInput(event.target.value)} placeholder="Message Lily…" /><button type="submit" disabled={props.sending || !props.input.trim()} aria-label="Send message"><SendHorizontal size={17} /></button></form>
            </div>
          </section>
        </div>
      </main>
    </div>
    {props.children}
  </div>;
}
