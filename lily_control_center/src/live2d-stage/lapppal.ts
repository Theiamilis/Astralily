/**
 * Copyright(c) Live2D Inc. All rights reserved.
 *
 * Use of this source code is governed by the Live2D Open Software license
 * that can be found at https://www.live2d.com/eula/live2d-open-software-license-agreement_en.html.
 */

/**
 * プラットフォーム依存機能を抽象化する Cubism Platform Abstraction Layer.
 *
 * ファイル読み込みや時刻取得等のプラットフォームに依存する関数をまとめる。
 */
export class LAppPal {
  private static debugVisible = false;

  private static ensureLogOverlay(): HTMLDivElement {
    let overlay = document.getElementById('live2d-stage-log') as HTMLDivElement | null;

    if (overlay) {
      return overlay;
    }

    overlay = document.createElement('div');
    overlay.id = 'live2d-stage-log';
    overlay.style.position = 'fixed';
    overlay.style.left = '8px';
    overlay.style.right = '8px';
    overlay.style.bottom = '8px';
    overlay.style.maxHeight = '32%';
    overlay.style.overflow = 'auto';
    overlay.style.padding = '8px';
    overlay.style.borderRadius = '12px';
    overlay.style.background = 'rgba(42, 24, 37, 0.72)';
    overlay.style.color = '#fff6fb';
    overlay.style.fontFamily = 'ui-monospace, SFMono-Regular, Consolas, monospace';
    overlay.style.fontSize = '10px';
    overlay.style.lineHeight = '1.5';
    overlay.style.whiteSpace = 'pre-wrap';
    overlay.style.zIndex = '9999';
    overlay.style.pointerEvents = 'auto';
    overlay.style.display = this.debugVisible ? 'block' : 'none';
    overlay.style.backdropFilter = 'blur(10px)';
    overlay.style.boxShadow = '0 18px 38px rgba(19, 10, 16, 0.28)';
    document.body.appendChild(overlay);

    return overlay;
  }

  public static setDebugVisible(visible: boolean): void {
    this.debugVisible = visible;
    const overlay = document.getElementById('live2d-stage-log') as HTMLDivElement | null;

    if (overlay) {
      overlay.style.display = visible ? 'block' : 'none';
    }
  }

  /**
   * ファイルをバイトデータとして読みこむ
   *
   * @param filePath 読み込み対象ファイルのパス
   * @return
   * {
   *      buffer,   読み込んだバイトデータ
   *      size        ファイルサイズ
   * }
   */
  public static loadFileAsBytes(
    filePath: string,
    callback: (arrayBuffer: ArrayBuffer, size: number) => void
  ): void {
    fetch(filePath)
      .then(response => response.arrayBuffer())
      .then(arrayBuffer => callback(arrayBuffer, arrayBuffer.byteLength));
  }

  /**
   * デルタ時間（前回フレームとの差分）を取得する
   * @return デルタ時間[ms]
   */
  public static getDeltaTime(): number {
    return this.deltaTime;
  }

  public static updateTime(): void {
    this.currentFrame = Date.now();
    this.deltaTime = (this.currentFrame - this.lastFrame) / 1000;
    this.lastFrame = this.currentFrame;
  }

  /**
   * メッセージを出力する
   * @param message 文字列
   */
  public static printMessage(message: string): void {
    console.log(message);
    const overlay = LAppPal.ensureLogOverlay();
    const nextLine = document.createElement('div');
    nextLine.textContent = message;
    overlay.appendChild(nextLine);
    overlay.scrollTop = overlay.scrollHeight;
  }

  static lastUpdate = Date.now();

  static currentFrame = 0.0;
  static lastFrame = 0.0;
  static deltaTime = 0.0;
}
