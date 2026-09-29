// Shared utility class — file downloads, alert handling, frame helpers.
import * as fs from 'fs';
import { Page, expect } from '@playwright/test';

export default class Common {
  constructor(public page: Page) {}

  public static emptyDownloads() {
    if (fs.existsSync('downloads')) {
      fs.readdirSync('downloads').forEach(f => fs.unlinkSync(`downloads/${f}`));
    }
  }

  public static renameFile(oldName: string, newName: string) {
    fs.renameSync(oldName, newName);
  }

  public static writeToJson(data: unknown, file: string) {
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
  }

  public static readJson(file: string) {
    const data = fs.readFileSync(file, 'utf-8');
    return JSON.parse(data);
  }

  public async uploadFileWithInputTag(selector: string, file: string) {
    await this.page.setInputFiles(selector, file);
  }

  public async uploadFileWithoutTag(selector: string, file: string) {
    this.page.on('filechooser', async (fileChooser) => {
      await fileChooser.setFiles(file);
    });
    await this.page.click(selector);
  }

  public async acceptAlert(selector: string, text?: string) {
    this.page.once('dialog', async (dialog) => {
      await dialog.accept(text);
    });
    await this.page.click(selector);
  }

  public async dismissAlert(selector: string) {
    this.page.once('dialog', async (dialog) => {
      await dialog.dismiss();
    });
    await this.page.click(selector);
  }

  public formatNumber(value: number, digit: number): string {
    if (value === 0)  return '0';
    if (value >= 1e9) return (value / 1e9).toFixed(digit) + 'B';
    if (value >= 1e6) return (value / 1e6).toFixed(digit) + 'M';
    if (value >= 1e3) return (value / 1e3).toFixed(digit) + 'K';
    return value.toString();
  }

  public getFrameLocator(frameSelector: string, elementSelector: string) {
    return this.page.frameLocator(frameSelector).locator(elementSelector);
  }

  public async getTextOfElement(frameSelector: string, elementSelector: string) {
    return this.page.frameLocator(frameSelector).locator(elementSelector).textContent();
  }

  public async waitForNetworkIdle(timeout = 30_000): Promise<void> {
    await this.page.waitForLoadState('networkidle', { timeout }).catch(() => {});
  }

  public async waitForUrl(urlPattern: string | RegExp, timeout = 60_000): Promise<void> {
    await this.page.waitForURL(urlPattern, { timeout });
  }
}
