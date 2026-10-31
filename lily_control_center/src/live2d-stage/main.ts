/**
 * Copyright(c) Live2D Inc. All rights reserved.
 *
 * Use of this source code is governed by the Live2D Open Software license
 * that can be found at https://www.live2d.com/eula/live2d-open-software-license-agreement_en.html.
 */

import { LAppDelegate } from './lappdelegate';
import * as LAppDefine from './lappdefine';
import { LAppPal } from './lapppal';

type StageTransformState = {
  scale: number;
  x: number;
  y: number;
};

const stageTransform: StageTransformState = {
  scale: 1,
  x: 0,
  y: 0
};

let controlsVisible = false;
let controlsHideTimer: number | null = null;

function getStageCanvas() {
  return document.querySelector('canvas') as HTMLCanvasElement | null;
}

function getStageControlElements() {
  return [
    document.getElementById('live2d-stage-viewport-controls') as HTMLDivElement | null,
    document.getElementById('live2d-stage-debug-toggle') as HTMLButtonElement | null
  ].filter(Boolean) as HTMLElement[];
}

function applyControlsVisibility() {
  const elements = getStageControlElements();
  const visible = controlsVisible || elements.some((element) => element.contains(document.activeElement));

  elements.forEach((element) => {
    element.style.opacity = visible ? '1' : '0';
    element.style.transform = visible ? 'translateY(0)' : 'translateY(6px)';
    element.style.pointerEvents = visible ? 'auto' : 'none';
  });
}

function showStageControls() {
  controlsVisible = true;

  if (controlsHideTimer !== null) {
    window.clearTimeout(controlsHideTimer);
    controlsHideTimer = null;
  }

  applyControlsVisibility();
}

function hideStageControlsSoon() {
  if (controlsHideTimer !== null) {
    window.clearTimeout(controlsHideTimer);
  }

  controlsHideTimer = window.setTimeout(() => {
    controlsVisible = false;
    applyControlsVisibility();
  }, 700);
}

function applyStageTransform() {
  const canvas = getStageCanvas();

  if (!canvas) {
    return;
  }

  canvas.style.transformOrigin = '50% 50%';
  canvas.style.transform = `translate(${stageTransform.x}px, ${stageTransform.y}px) scale(${stageTransform.scale})`;
  canvas.style.willChange = 'transform';
  canvas.style.touchAction = 'none';
  canvas.style.userSelect = 'none';
  canvas.style.cursor = 'grab';
}

function clampScale(nextScale: number) {
  return Math.min(2.6, Math.max(0.55, nextScale));
}

function clampPointerAxis(value: number) {
  return Math.max(-1, Math.min(1, value));
}

function forwardCursorToModel(clientX: number, clientY: number) {
  const canvas = getStageCanvas();

  if (!canvas) {
    return;
  }

  const rect = canvas.getBoundingClientRect();

  if (rect.width <= 0 || rect.height <= 0) {
    return;
  }

  const normalizedX = ((clientX - rect.left) / rect.width) * 2 - 1;
  const normalizedY = ((clientY - rect.top) / rect.height) * 2 - 1;

  LAppDelegate.getInstance().onCursorMove(
    clampPointerAxis(normalizedX),
    clampPointerAxis(-normalizedY)
  );
}

function setStageScale(nextScale: number) {
  stageTransform.scale = clampScale(nextScale);
  applyStageTransform();
}

function resetStageTransform(nextScale = 1, nextX = 0, nextY = 0) {
  stageTransform.scale = clampScale(nextScale);
  stageTransform.x = nextX;
  stageTransform.y = nextY;
  applyStageTransform();
}

function ensureDebugToggle() {
  let toggle = document.getElementById('live2d-stage-debug-toggle') as HTMLButtonElement | null;

  if (toggle) {
    return toggle;
  }

  toggle = document.createElement('button');
  toggle.id = 'live2d-stage-debug-toggle';
  toggle.type = 'button';
  toggle.textContent = 'Debug';
  toggle.setAttribute('aria-pressed', 'false');
  toggle.style.position = 'fixed';
  toggle.style.right = '10px';
  toggle.style.bottom = '10px';
  toggle.style.padding = '6px 10px';
  toggle.style.border = '1px solid rgba(255,255,255,0.45)';
  toggle.style.borderRadius = '999px';
  toggle.style.background = 'rgba(255, 245, 251, 0.88)';
  toggle.style.color = '#5d3b4f';
  toggle.style.fontFamily = 'ui-sans-serif, system-ui, sans-serif';
  toggle.style.fontSize = '10px';
  toggle.style.fontWeight = '600';
  toggle.style.letterSpacing = '0.08em';
  toggle.style.textTransform = 'uppercase';
  toggle.style.cursor = 'pointer';
  toggle.style.zIndex = '100000';
  toggle.style.pointerEvents = 'auto';
  toggle.style.boxShadow = '0 10px 24px rgba(34, 18, 29, 0.22)';
  toggle.style.opacity = '0';
  toggle.style.transform = 'translateY(6px)';
  toggle.style.transition = 'opacity 180ms ease, transform 180ms ease';
  document.body.appendChild(toggle);

  toggle.addEventListener('pointerenter', showStageControls);
  toggle.addEventListener('pointerleave', hideStageControlsSoon);
  toggle.addEventListener('focus', showStageControls);
  toggle.addEventListener('blur', hideStageControlsSoon);

  return toggle;
}

function ensureViewportControls() {
  let controls = document.getElementById('live2d-stage-viewport-controls') as HTMLDivElement | null;

  if (controls) {
    return controls;
  }

  controls = document.createElement('div');
  controls.id = 'live2d-stage-viewport-controls';
  controls.style.position = 'fixed';
  controls.style.left = '10px';
  controls.style.bottom = '10px';
  controls.style.display = 'flex';
  controls.style.alignItems = 'center';
  controls.style.gap = '8px';
  controls.style.zIndex = '100000';
  controls.style.pointerEvents = 'auto';
  controls.style.opacity = '0';
  controls.style.transform = 'translateY(6px)';
  controls.style.transition = 'opacity 180ms ease, transform 180ms ease';

  const makeButton = (label: string, onClick: () => void) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.style.padding = '6px 10px';
    button.style.border = '1px solid rgba(255,255,255,0.45)';
    button.style.borderRadius = '999px';
    button.style.background = 'rgba(255, 245, 251, 0.88)';
    button.style.color = '#5d3b4f';
    button.style.fontFamily = 'ui-sans-serif, system-ui, sans-serif';
    button.style.fontSize = '10px';
    button.style.fontWeight = '600';
    button.style.letterSpacing = '0.08em';
    button.style.textTransform = 'uppercase';
    button.style.cursor = 'pointer';
    button.style.boxShadow = '0 10px 24px rgba(34, 18, 29, 0.22)';
    button.addEventListener('click', onClick);
    controls!.appendChild(button);
  };

  makeButton('Zoom +', () => setStageScale(stageTransform.scale + 0.12));
  makeButton('Zoom -', () => setStageScale(stageTransform.scale - 0.12));
  makeButton('Reset', () => resetStageTransform());

  document.body.appendChild(controls);

  controls.addEventListener('pointerenter', showStageControls);
  controls.addEventListener('pointerleave', hideStageControlsSoon);
  controls.addEventListener('focusin', showStageControls);
  controls.addEventListener('focusout', hideStageControlsSoon);

  return controls;
}

function ensureStageStatus() {
  let status = document.getElementById('live2d-stage-status') as HTMLDivElement | null;

  if (status) {
    return status;
  }

  status = document.createElement('div');
  status.id = 'live2d-stage-status';
  status.style.position = 'fixed';
  status.style.top = '8px';
  status.style.left = '8px';
  status.style.right = '8px';
  status.style.padding = '8px 10px';
  status.style.borderRadius = '12px';
  status.style.background = 'rgba(42, 24, 37, 0.72)';
  status.style.color = '#fff6fb';
  status.style.fontFamily = 'ui-monospace, SFMono-Regular, Consolas, monospace';
  status.style.fontSize = '10px';
  status.style.lineHeight = '1.5';
  status.style.whiteSpace = 'pre-wrap';
  status.style.zIndex = '99999';
  status.style.pointerEvents = 'none';
  status.style.display = 'none';
  status.textContent = '';
  document.body.appendChild(status);

  return status;
}

function setStageStatus(message: string) {
  const status = ensureStageStatus();
  status.textContent = message;
  status.style.display = 'block';
}

function clearStageStatus() {
  const status = document.getElementById('live2d-stage-status') as HTMLDivElement | null;

  if (!status) {
    return;
  }

  status.textContent = '';
  status.style.display = 'none';
}

function wireParentCursorBridge() {
  window.addEventListener('message', (event: MessageEvent) => {
    if (event.origin !== window.location.origin || event.source !== window.parent) {
      return;
    }

    const data = event.data as
      | {
          type?: string;
          clientX?: number;
          clientY?: number;
          expressionId?: string;
          lipSyncLevel?: number;
          scale?: number;
          x?: number;
          y?: number;
        }
      | undefined;

    if (!data?.type) {
      return;
    }

    if (data.type === 'lily-live2d-cursor') {
      if (typeof data.clientX === 'number' && typeof data.clientY === 'number') {
        forwardCursorToModel(data.clientX, data.clientY);
      }

      return;
    }

    if (data.type === 'lily-live2d-cursor-reset') {
      LAppDelegate.getInstance().resetCursorMove();
      return;
    }

    if (data.type === 'lily-live2d-set-expression') {
      if (typeof data.expressionId === 'string' && data.expressionId.trim()) {
        LAppDelegate.getInstance()
          .getPrimaryLive2DManager()
          ?.setExpression(data.expressionId.trim());
      }

      return;
    }

    if (data.type === 'lily-live2d-toggle-expression') {
      if (typeof data.expressionId === 'string' && data.expressionId.trim()) {
        LAppDelegate.getInstance()
          .getPrimaryLive2DManager()
          ?.toggleExpression(data.expressionId.trim());
      }

      return;
    }

    if (data.type === 'lily-live2d-clear-expressions') {
      LAppDelegate.getInstance().getPrimaryLive2DManager()?.clearExpressions();
      return;
    }

    if (data.type === 'lily-live2d-lipsync-level') {
      const level = typeof data.lipSyncLevel === 'number' ? data.lipSyncLevel : 0;
      LAppDelegate.getInstance().getPrimaryLive2DManager()?.setLipSyncLevel(level);
      return;
    }

    if (data.type === 'lily-live2d-reset-viewport') {
      resetStageTransform(
        typeof data.scale === 'number' ? data.scale : 1,
        typeof data.x === 'number' ? data.x : 0,
        typeof data.y === 'number' ? data.y : 0
      );
      return;
    }

    if (data.type === 'lily-live2d-random-expression') {
      LAppDelegate.getInstance().getPrimaryLive2DManager()?.setRandomExpression();
    }
  });
}

function wireDebugToggle() {
  const toggle = ensureDebugToggle();
  let visible = false;

  toggle.addEventListener('click', () => {
    visible = !visible;
    LAppPal.setDebugVisible(visible);
    toggle.setAttribute('aria-pressed', visible ? 'true' : 'false');
    toggle.textContent = visible ? 'Hide Debug' : 'Debug';
  });
}

function wireViewportControls() {
  ensureViewportControls();
  applyControlsVisibility();

  let dragActive = false;
  let startX = 0;
  let startY = 0;
  let originX = 0;
  let originY = 0;

  const beginDrag = (event: PointerEvent) => {
    const target = event.target as HTMLElement | null;

    if (!target) {
      return;
    }

    if (target.closest('#live2d-stage-debug-toggle') || target.closest('#live2d-stage-viewport-controls')) {
      return;
    }

    if (!target.closest('canvas')) {
      return;
    }

    dragActive = true;
    startX = event.clientX;
    startY = event.clientY;
    originX = stageTransform.x;
    originY = stageTransform.y;

    const canvas = getStageCanvas();
    if (canvas) {
      canvas.style.cursor = 'grabbing';
    }
  };

  const moveDrag = (event: PointerEvent) => {
    if (!dragActive) {
      return;
    }

    stageTransform.x = originX + (event.clientX - startX);
    stageTransform.y = originY + (event.clientY - startY);
    applyStageTransform();
  };

  const endDrag = () => {
    dragActive = false;
    const canvas = getStageCanvas();
    if (canvas) {
      canvas.style.cursor = 'grab';
    }
  };

  document.addEventListener('pointerdown', beginDrag);
  document.addEventListener('pointermove', moveDrag);
  document.addEventListener('pointerup', endDrag);
  document.addEventListener('pointercancel', endDrag);

  document.addEventListener('pointermove', (event) => {
    if (dragActive) {
      return;
    }

    forwardCursorToModel(event.clientX, event.clientY);
  });

  window.addEventListener('blur', () => {
    LAppDelegate.getInstance().resetCursorMove();
  });

  document.addEventListener('pointermove', (event) => {
    const nearBottomZone = event.clientY >= window.innerHeight - 92;
    const target = event.target as HTMLElement | null;
    const overControl =
      !!target?.closest('#live2d-stage-viewport-controls') ||
      !!target?.closest('#live2d-stage-debug-toggle');

    if (nearBottomZone || overControl) {
      showStageControls();
      return;
    }

    if (!dragActive) {
      hideStageControlsSoon();
    }
  });

  document.addEventListener(
    'wheel',
    (event) => {
      const target = event.target as HTMLElement | null;

      if (!target?.closest('canvas')) {
        return;
      }

      event.preventDefault();
      const delta = event.deltaY < 0 ? 0.08 : -0.08;
      setStageScale(stageTransform.scale + delta);
    },
    { passive: false }
  );

  window.addEventListener('mouseout', (event) => {
    const relatedTarget = event.relatedTarget as Node | null;

    if (relatedTarget === null) {
      LAppDelegate.getInstance().resetCursorMove();
    }
  });
}

window.addEventListener('error', (event) => {
  setStageStatus(`window error: ${event.message}`);
});

window.addEventListener('unhandledrejection', (event) => {
  const reason = event.reason instanceof Error ? event.reason.message : String(event.reason);
  setStageStatus(`promise error: ${reason}`);
});

/**
 * ブラウザロード後の処理
 */
window.addEventListener(
  'load',
  (): void => {
    wireDebugToggle();
    wireViewportControls();
    wireParentCursorBridge();
    clearStageStatus();
    // Initialize WebGL and create the application instance
    try {
      if (!LAppDelegate.getInstance().initialize()) {
        setStageStatus('stage: initialize returned false');
        return;
      }

      LAppDelegate.getInstance().run();
      window.requestAnimationFrame(() => applyStageTransform());
      clearStageStatus();
    } catch (error) {
      const message = error instanceof Error ? error.stack ?? error.message : String(error);
      setStageStatus(`stage init exception: ${message}`);
    }
  },
  { passive: true }
);

/**
 * 終了時の処理
 */
window.addEventListener(
  'beforeunload',
  (): void => LAppDelegate.releaseInstance(),
  { passive: true }
);
