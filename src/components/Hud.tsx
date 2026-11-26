import { forwardRef, useImperativeHandle, useRef } from 'react';
import type { GameState } from '../engine/WinterEngine';

export interface HudHandle {
  update: (g: GameState) => void;
}

const BAR = 18;

function clock(sec: number): string {
  const s = Math.floor(sec);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function bar(value: number, max: number): string {
  const filled = Math.round((Math.max(0, value) / max) * BAR);
  return `${'█'.repeat(filled)}${'░'.repeat(BAR - filled)} ${String(Math.round(value)).padStart(3)}`;
}

/**
 * Survival HUD. It is updated imperatively ~10x a second straight from the
 * engine's stats callback, so React never re-renders during play.
 */
export const Hud = forwardRef<HudHandle>(function Hud(_props, ref) {
  const fuelRef = useRef<HTMLSpanElement>(null);
  const hpRef = useRef<HTMLSpanElement>(null);
  const ammoRef = useRef<HTMLSpanElement>(null);
  const sticksRef = useRef<HTMLSpanElement>(null);
  const killsRef = useRef<HTMLSpanElement>(null);
  const timeRef = useRef<HTMLSpanElement>(null);
  const promptRef = useRef<HTMLDivElement>(null);
  const msgRef = useRef<HTMLDivElement>(null);
  const hurtRef = useRef<HTMLDivElement>(null);
  const overRef = useRef<HTMLDivElement>(null);
  const overTitleRef = useRef<HTMLPreElement>(null);
  const overTimeRef = useRef<HTMLSpanElement>(null);
  const overKillsRef = useRef<HTMLSpanElement>(null);

  useImperativeHandle(ref, () => ({
    update(g) {
      if (fuelRef.current) {
        fuelRef.current.textContent = `${bar(g.fuel, 100)}%`;
        fuelRef.current.className = g.fuel < 25 ? 'fuel low' : 'fuel';
      }
      if (hpRef.current) {
        hpRef.current.textContent = bar(g.hp, 100);
        hpRef.current.className = g.hp < 35 ? 'hp low' : 'hp';
      }
      if (ammoRef.current) {
        ammoRef.current.textContent = g.reloading
          ? 'RELOADING...'
          : `${'▮'.repeat(g.ammo)}${'▯'.repeat(g.mag - g.ammo)} ${g.ammo}/${g.mag}`;
      }
      if (sticksRef.current) {
        sticksRef.current.textContent =
          `${'▮'.repeat(g.carried)}${'▯'.repeat(g.maxCarry - g.carried)} ${g.carried}/${g.maxCarry}`;
      }
      if (killsRef.current) killsRef.current.textContent = String(g.kills);
      if (timeRef.current) timeRef.current.textContent = clock(g.survived);

      let prompt = '';
      if (!g.over) {
        if (g.nearFire && g.carried > 0) prompt = '[E]  FEED THE FIRE';
        else if (g.ammo === 0 && !g.reloading) prompt = '[R]  RELOAD';
        else if (g.fuel < 25) prompt = 'THE FIRE IS DYING — FIND STICKS IN THE FOREST';
        else if (g.survived < 12) prompt = 'KEEP THE FIRE ALIVE — ZOMBIES FEAR ITS LIGHT';
      }
      if (promptRef.current) promptRef.current.textContent = prompt;
      if (msgRef.current) msgRef.current.textContent = g.message;
      if (hurtRef.current) hurtRef.current.style.opacity = String(Math.min(0.55, g.hurt * 0.55));
      if (overRef.current) overRef.current.style.display = g.over ? 'flex' : 'none';
      if (overTitleRef.current) {
        overTitleRef.current.textContent = g.overReason === 'killed' ? 'THE DEAD GOT YOU' : 'THE FIRE WENT OUT';
      }
      if (overTimeRef.current) overTimeRef.current.textContent = clock(g.survived);
      if (overKillsRef.current) overKillsRef.current.textContent = String(g.kills);
    },
  }), []);

  return (
    <>
      <div className="hurt" ref={hurtRef} />
      <div className="hud">
        <div>FIRE   <span ref={fuelRef} className="fuel" /></div>
        <div>HEALTH <span ref={hpRef} className="hp" /></div>
        <div>AMMO   <span ref={ammoRef} className="ammo" /></div>
        <div>STICKS <span ref={sticksRef} className="sticks" /></div>
        <div>KILLS  <span ref={killsRef} className="time" />   TIME <span ref={timeRef} className="time" /></div>
      </div>
      <div className="prompt" ref={promptRef} />
      <div className="message" ref={msgRef} />
      <div className="gameover" ref={overRef} style={{ display: 'none' }}>
        <pre ref={overTitleRef}>THE FIRE WENT OUT</pre>
        <div>you survived <span ref={overTimeRef} /> and put down <span ref={overKillsRef} /> zombies</div>
        <div className="dim">press R to relight the fire and try again</div>
      </div>
    </>
  );
});
