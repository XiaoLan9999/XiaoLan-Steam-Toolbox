import { BrowserWindow } from 'electron'
import { randomUUID } from 'node:crypto'
import type { ScreenshotImageAdapter } from './steam-screenshots'
import { DomainError } from '../shared/domain'

export class ScreenshotBrowserImageAdapter implements ScreenshotImageAdapter {
  private window: BrowserWindow | null = null
  private ready: Promise<void> | null = null
  private disposed = false

  async inspect(data: Buffer): Promise<{ width: number; height: number; previewJpeg: Buffer }> {
    const result = await this.convert(data)
    return { width: result.width, height: result.height, previewJpeg: Buffer.from(result.preview, 'base64') }
  }

  async encode(data: Buffer, options: { quality: number; width: number; height: number; thumbnailWidth: number; thumbnailHeight: number }): Promise<{ jpeg: Buffer; thumbnail: Buffer }> {
    const result = await this.convert(data, options)
    return { jpeg: Buffer.from(result.jpeg!, 'base64'), thumbnail: Buffer.from(result.thumbnail!, 'base64') }
  }

  dispose(): void {
    this.disposed = true
    this.closeWorker()
  }

  closeWorker(): void {
    if (this.window && !this.window.isDestroyed()) this.window.destroy()
    this.window = null
    this.ready = null
  }

  private async convert(data: Buffer, options?: { quality: number; width: number; height: number; thumbnailWidth: number; thumbnailHeight: number }): Promise<{ width: number; height: number; preview: string; jpeg?: string; thumbnail?: string }> {
    if (this.disposed) throw new DomainError('SCREENSHOT_CANCELLED', '截图工具已关闭')
    if (!this.window || this.window.isDestroyed()) {
      const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true,
        nodeIntegration: false, webviewTag: false, backgroundThrottling: false, partition: `screenshot-images-${randomUUID()}` } })
      this.window = window
      window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
      window.webContents.on('will-navigate', event => event.preventDefault())
      window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
      window.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'file://*/*'] }, (_request, callback) => callback({ cancel: true }))
      this.ready = window.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(
        '<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src data:; connect-src \'none\'; script-src \'none\'"></head><body></body></html>'))
    }
    const window = this.window
    await this.ready
    if (this.disposed || window.isDestroyed()) throw new DomainError('SCREENSHOT_CANCELLED', '截图工具已关闭')
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        window.webContents.executeJavaScript(`(async () => {
          const data = ${JSON.stringify(data.toString('base64'))};
          const options = ${JSON.stringify(options ?? null)};
          const image = new Image();
          const canvases = [];
          const render = (width, height, quality) => {
            const canvas = document.createElement('canvas'); canvases.push(canvas);
            canvas.width = width; canvas.height = height;
            const context = canvas.getContext('2d', {alpha:false});
            if (!context) throw new Error('Cannot create screenshot canvas');
            context.fillStyle = '#ffffff'; context.fillRect(0, 0, width, height);
            context.drawImage(image, 0, 0, width, height);
            return canvas.toDataURL('image/jpeg', quality).split(',')[1];
          };
          try {
            await new Promise((resolve, reject) => { image.onload=resolve; image.onerror=()=>reject(new Error('Invalid screenshot image')); image.src='data:application/octet-stream;base64,'+data; });
            const width=image.naturalWidth, height=image.naturalHeight;
            if (!width || !height || width*height > 64000000) throw new Error('Screenshot dimensions exceed limit');
            const scale=Math.min(1,320/width,200/height);
            const result={width,height,preview:render(Math.max(1,Math.round(width*scale)),Math.max(1,Math.round(height*scale)),0.7)};
            if(options){result.jpeg=render(options.width,options.height,options.quality/100);result.thumbnail=render(options.thumbnailWidth,options.thumbnailHeight,0.85);}
            return result;
          } finally { for(const canvas of canvases){canvas.width=0;canvas.height=0;}image.src=''; }
        })()`, true),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            if (!window.isDestroyed()) window.destroy()
            reject(new DomainError('SCREENSHOT_IMAGE_TIMEOUT', '图片转换超时，请减少图片尺寸后重试'))
          }, 30_000)
          timer.unref?.()
        })
      ])
    } finally { clearTimeout(timer) }
  }
}
