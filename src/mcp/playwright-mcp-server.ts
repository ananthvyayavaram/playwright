// In-process MCP server exposing 19 Playwright browser tools (navigate, click, fill, screenshot, etc.) to AI agents.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { Browser, BrowserContext, Locator, Page, chromium } from 'playwright';

interface ServerState {
  browser: Browser | null;
  context: BrowserContext | null;
  page: Page | null;
}

async function ensurePage(state: ServerState, headless: boolean): Promise<Page> {
  if (!state.browser) {
    state.browser = await chromium.launch({ headless });
  }
  if (!state.context) {
    state.context = await state.browser.newContext({ viewport: { width: 1920, height: 1080 } });
  }
  if (!state.page) {
    state.page = await state.context.newPage();
  }
  return state.page;
}

export interface PlaywrightMcpServer {
  server: McpServer;
  cleanup: () => Promise<void>;
}

export async function createPlaywrightMcpServer(headless = true): Promise<PlaywrightMcpServer> {
  const state: ServerState = { browser: null, context: null, page: null };
  const getPage = () => ensurePage(state, headless);
  const server  = new McpServer({ name: 'playwright-mcp', version: '1.0.0' });

  server.registerTool('browser_navigate', {
    description: 'Navigate to a URL. Returns page title and current URL after navigation.',
    inputSchema: {
      url:       z.string().describe('Full URL to navigate to'),
      waitUntil: z.enum(['load', 'domcontentloaded', 'networkidle']).optional().describe('When navigation is done (default: domcontentloaded)'),
    },
  }, async ({ url, waitUntil = 'domcontentloaded' }) => {
    const page = await getPage();
    await page.goto(url, { waitUntil });
    return { content: [{ type: 'text' as const, text: JSON.stringify({ url: page.url(), title: await page.title(), status: 'navigated' }) }] };
  });

  server.registerTool('browser_screenshot', {
    description: 'Take a screenshot of the current page to observe its visual state.',
    inputSchema: {},
  }, async () => {
    const page       = await getPage();
    // viewport-only + lower quality = ~50% smaller than quality:60 fullPage
    const screenshot = await page.screenshot({ type: 'jpeg', quality: 45, fullPage: false });
    return {
      content: [
        { type: 'text' as const,  text: `URL: ${page.url()} | Title: ${await page.title()}` },
        { type: 'image' as const, data: screenshot.toString('base64'), mimeType: 'image/jpeg' },
      ],
    };
  });

  server.registerTool('browser_get_content', {
    description: 'Get the current page structure: text content, interactive elements (inputs, buttons, links).',
    inputSchema: { selector: z.string().optional().describe('Limit extraction to a CSS selector') },
  }, async ({ selector }) => {
    const page    = await getPage();
    const content = await page.evaluate((sel) => {
      const root = sel ? (document.querySelector(sel) as HTMLElement | null) : document.body;
      if (!root) return { error: `Selector "${sel}" not found` };
      const elements: string[] = [];
      const tags = ['a', 'button', 'input', 'select', 'textarea', '[role="button"]', '[data-testid]', '[role="option"]', '[role="menuitem"]', '[role="tab"]'];
      tags.forEach((tag) => {
        root.querySelectorAll(tag).forEach((el) => {
          const e    = el as HTMLElement;
          const id   = e.id ? `#${e.id}` : '';
          const name = e.getAttribute('name') ? `[name="${e.getAttribute('name')}"]` : '';
          const ph   = e.getAttribute('placeholder') ? ` placeholder="${e.getAttribute('placeholder')}"` : '';
          const type = e.getAttribute('type') ? ` type="${e.getAttribute('type')}"` : '';
          const tid  = e.getAttribute('data-testid') ? ` data-testid="${e.getAttribute('data-testid')}"` : '';
          const aria = e.getAttribute('aria-label') ? ` aria-label="${e.getAttribute('aria-label')}"` : '';
          const role = e.getAttribute('role') ? ` role="${e.getAttribute('role')}"` : '';
          const text = (e.textContent?.trim() || '').slice(0, 100);
          const href = (e as HTMLAnchorElement).href ? ` href="${(e as HTMLAnchorElement).href.slice(0, 80)}"` : '';
          const disabled = (e as HTMLInputElement).disabled ? ' disabled' : '';
          elements.push(`<${e.tagName.toLowerCase()}${id}${name}${type}${tid}${aria}${role}${ph}${href}${disabled}> "${text}"`);
        });
      });
      return { title: document.title, url: window.location.href, bodyText: (document.body.innerText || '').slice(0, 1500), elements: elements.slice(0, 80) };
    }, selector ?? null);
    return { content: [{ type: 'text' as const, text: JSON.stringify(content, null, 2) }] };
  });

  server.registerTool('browser_query_all', {
    description: `Query ALL elements matching a CSS selector. Each result includes:
- ALL stable HTML attributes (name, aria-label, placeholder, data-testid, type, role, etc.)
- allAttributes: complete dump of every attribute on the element (excluding auto-generated IDs/classes)
- locatorSuggestions: RANKED array of ALL possible Playwright locators from most stable to least
  USE locatorSuggestions[0] as the locator to write in generated code.
  Priority: data-testid > name attr (form fields) > getByLabel > getByRole > aria-label > placeholder > text
- semanticLocator: same as locatorSuggestions[0] for backward compatibility`,
    inputSchema: {
      selector: z.string().describe('CSS selector to query (e.g. "button", "input", "[role=\'option\']", "button,input,select")'),
      limit:    z.number().optional().describe('Max elements to return (default: 50)'),
    },
  }, async ({ selector, limit = 50 }) => {
    const page    = await getPage();
    const results = await page.evaluate(({ sel, lim }) => {

      // Auto-generated ID patterns — never use these as locators
      function isAutoGeneratedId(id: string): boolean {
        return /^(mantine-|ruid-|react-select-|rc_|css-|chakra-|radix-)/i.test(id);
      }

      // Resolve all visible label text a human would associate with this element
      function getAccessibleLabel(e: HTMLElement): string {
        // 1. Explicit aria-label attribute
        const aria = e.getAttribute('aria-label');
        if (aria) return aria.trim();

        // 2. aria-labelledby → resolve each referenced element's text
        const lby = e.getAttribute('aria-labelledby');
        if (lby) {
          const t = lby.split(/\s+/)
            .map(id => document.getElementById(id)?.textContent?.trim())
            .filter(Boolean).join(' ');
          if (t) return t;
        }

        // 3. <label for="id"> association (only if id is not auto-generated)
        if (e.id && !isAutoGeneratedId(e.id)) {
          const lbl = document.querySelector(`label[for="${e.id}"]`);
          if (lbl) return lbl.textContent?.trim() || '';
        }

        // 4. Walk up DOM to find wrapping <label> (implicit association)
        let p = e.parentElement;
        let depth = 0;
        while (p && depth < 6) {
          if (p.tagName === 'LABEL') {
            const c = p.cloneNode(true) as HTMLElement;
            c.querySelectorAll('input,select,textarea,button').forEach(ch => ch.remove());
            const t = c.textContent?.trim() || '';
            if (t) return t;
          }
          p = p.parentElement;
          depth++;
        }

        // 5. Nearest preceding sibling or cousin <label> with matching-ish text
        // (Mantine pattern: label div is a sibling of the input wrapper div)
        let cur: HTMLElement | null = e;
        for (let d = 0; d < 4; d++) {
          cur = cur?.parentElement ?? null;
          if (!cur) break;
          const labels = cur.querySelectorAll('label,[class*="label"],[class*="Label"]');
          for (const lbl of Array.from(labels)) {
            const t = (lbl as HTMLElement).textContent?.trim() || '';
            if (t && t.length < 60) return t;
          }
        }

        // 6. For buttons/links, visible text content is the accessible name
        const tag = e.tagName.toLowerCase();
        if (tag === 'button' || tag === 'a' || e.getAttribute('role') === 'button') {
          return (e.textContent?.trim() || '').slice(0, 80);
        }
        return '';
      }

      // Collect ALL meaningful attributes (skip auto-generated noise)
      function getAllStableAttributes(e: HTMLElement): Record<string, string> {
        const attrs: Record<string, string> = {};
        for (const attr of Array.from(e.attributes)) {
          const n = attr.name;
          const v = attr.value;
          if (!v) continue;
          // Skip auto-generated IDs
          if (n === 'id' && isAutoGeneratedId(v)) continue;
          // Skip Mantine/CSS-in-JS class noise but keep data-* and semantic classes
          if (n === 'class') {
            const stable = v.split(/\s+/)
              .filter(c => !c.startsWith('mantine-') && !c.startsWith('css-') && !c.startsWith('m_') && c.length > 0)
              .join(' ');
            if (stable) attrs['class'] = stable;
            continue;
          }
          attrs[n] = v.slice(0, 120);
        }
        // Add contenteditable explicitly
        if (e.isContentEditable) attrs['contenteditable'] = 'true';
        return attrs;
      }

      // Build ALL possible locators ranked by stability
      // locatorSuggestions[0] is what generated code should use
      function buildAllLocators(e: HTMLElement, label: string): string[] {
        const tag        = e.tagName.toLowerCase();
        const isFormField = ['input', 'textarea', 'select'].includes(tag) || e.isContentEditable;
        const role       = e.getAttribute('role') || '';
        const nameAttr   = e.getAttribute('name') || '';
        const ph         = e.getAttribute('placeholder') || '';
        const testid     = e.getAttribute('data-testid') || '';
        const ariaLabel  = e.getAttribute('aria-label') || '';
        const id         = e.id || '';
        const type       = e.getAttribute('type') || '';
        const text       = (e.textContent?.trim() || '').slice(0, 60);
        const safe       = (s: string) => s.replace(/'/g, "\\'");

        // Determine effective ARIA role
        const implicitRole =
          role ? role :
          tag === 'button' ? 'button' :
          type === 'submit' || type === 'button' ? 'button' :
          tag === 'a' ? 'link' :
          (tag === 'input' && type === 'checkbox') ? 'checkbox' :
          (tag === 'input' && type === 'radio') ? 'radio' :
          tag === 'select' ? 'combobox' :
          (tag === 'input' || tag === 'textarea') ? 'textbox' :
          e.isContentEditable ? 'textbox' :
          '';

        const suggestions: string[] = [];

        // TIER 1: data-testid — explicitly placed by dev for testing
        if (testid) {
          suggestions.push(`page.locator('[data-testid="${safe(testid)}"]')`);
        }

        // TIER 2: name attribute — form fields only, backend-tied, NEVER auto-generated
        if (nameAttr && isFormField) {
          suggestions.push(`page.locator('${tag}[name="${safe(nameAttr)}"]')`);
          suggestions.push(`page.locator('[name="${safe(nameAttr)}"]')`);
        }

        // TIER 3: getByLabel — works when label is properly associated
        if (label && isFormField) {
          suggestions.push(`page.getByLabel('${safe(label)}')`);
        }

        // TIER 4: getByRole with accessible name
        if (implicitRole && label) {
          suggestions.push(`page.getByRole('${safe(implicitRole)}', { name: '${safe(label)}' })`);
        } else if (implicitRole && text && !isFormField) {
          suggestions.push(`page.getByRole('${safe(implicitRole)}', { name: '${safe(text)}' })`);
        }

        // TIER 5: aria-label attribute (when different from computed label)
        if (ariaLabel && ariaLabel !== label) {
          suggestions.push(`page.locator('[aria-label="${safe(ariaLabel)}"]')`);
        }

        // TIER 6: placeholder
        if (ph && isFormField) {
          suggestions.push(`page.getByPlaceholder('${safe(ph)}')`);
          suggestions.push(`page.locator('[placeholder="${safe(ph)}"]')`);
        }

        // TIER 7: getByText (for links, menu items, option text, visible button text)
        if ((tag === 'a' || role === 'menuitem' || role === 'option' || role === 'link') && text) {
          suggestions.push(`page.getByText('${safe(text)}', { exact: true })`);
        }
        if (tag === 'button' && text && !label) {
          suggestions.push(`page.getByText('${safe(text)}', { exact: true })`);
        }

        // TIER 8: stable non-auto-generated ID
        if (id && !isAutoGeneratedId(id)) {
          suggestions.push(`page.locator('#${safe(id)}')`);
        }

        // TIER 9: contenteditable (rich-text editors)
        if (e.isContentEditable) {
          suggestions.push(`page.locator('[contenteditable="true"]')`);
        }

        // TIER 10: type-based (last resort for unique inputs)
        if (type && isFormField && !suggestions.length) {
          suggestions.push(`page.locator('${tag}[type="${safe(type)}"]')`);
        }

        return [...new Set(suggestions)];
      }

      const els = Array.from(document.querySelectorAll(sel)).slice(0, lim);
      return els.map((el) => {
        const e      = el as HTMLElement;
        const rect   = e.getBoundingClientRect();
        const style  = window.getComputedStyle(e);
        const label  = getAccessibleLabel(e);
        const locatorSuggestions = buildAllLocators(e, label);
        const allAttributes = getAllStableAttributes(e);

        const raw: Record<string, unknown> = {
          tag:               e.tagName.toLowerCase(),
          // All stable HTML attributes visible to the AI
          allAttributes,
          // Key attributes surfaced at top level for quick reading
          name:              e.getAttribute('name')         || null,
          type:              e.getAttribute('type')         || null,
          testid:            e.getAttribute('data-testid')  || null,
          ariaLabel:         e.getAttribute('aria-label')   || null,
          ariaLabelledBy:    e.getAttribute('aria-labelledby') || null,
          role:              e.getAttribute('role')         || null,
          placeholder:       e.getAttribute('placeholder')  || null,
          id:                (e.id && !isAutoGeneratedId(e.id)) ? e.id : null,
          contenteditable:   e.isContentEditable ? true : null,
          value:             (e as HTMLInputElement).value  || null,
          text:              (e.textContent?.trim() || '').slice(0, 80) || null,
          href:              (e as HTMLAnchorElement).href  || null,
          visible:           rect.width > 0 && rect.height > 0
                               && style.visibility !== 'hidden'
                               && style.display !== 'none',
          disabled:          (e as HTMLInputElement).disabled ? true : null,
          accessibleLabel:   label || null,
          // RANKED locator suggestions — use [0] in generated code
          locatorSuggestions,
          semanticLocator:   locatorSuggestions[0] ?? null,
        };
        return Object.fromEntries(Object.entries(raw).filter(([, v]) => v !== null && v !== '' && !(Array.isArray(v) && v.length === 0)));
      });
    }, { sel: selector, lim: limit });

    return { content: [{ type: 'text' as const, text: JSON.stringify(results, null, 2) }] };
  });

  server.registerTool('browser_wait_for_idle', {
    description: 'Wait for the page to become idle after a navigation or SPA transition. Uses domcontentloaded (fast). Only call this after navigation actions — NOT after every click.',
    inputSchema: {
      timeout: z.number().optional().describe('Max wait time in ms (default: 3000)'),
    },
  }, async ({ timeout = 3000 }) => {
    const page = await getPage();
    try {
      // domcontentloaded fires as soon as the DOM is parsed — much faster than
      // networkidle on SPAs that keep background polling alive indefinitely.
      await page.waitForLoadState('domcontentloaded', { timeout });
      return { content: [{ type: 'text' as const, text: JSON.stringify({ status: 'idle', url: page.url(), title: await page.title() }) }] };
    } catch {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ status: 'timeout-reached', url: page.url(), note: 'Page may still be loading' }) }] };
    }
  });

  server.registerTool('browser_click', {
    description: 'Click an element. Prefer semantic params (role+name or label) so the generated code uses stable Playwright locators. CSS selector is fallback only.',
    inputSchema: {
      selector: z.string().optional().describe('CSS selector — fallback; prefer role+name or label'),
      text:     z.string().optional().describe('Visible text of the element (partial match)'),
      role:     z.string().optional().describe('ARIA role for semantic click (e.g. button, tab, menuitem, link) — use together with name'),
      name:     z.string().optional().describe('Accessible name — use together with role (e.g. "Create Experience")'),
      label:    z.string().optional().describe('Visible label text — clicks the control whose label matches this text'),
    },
  }, async ({ selector, text, role, name, label }) => {
    const page = await getPage();
    if (role && name) {
      await page.getByRole(role as Parameters<typeof page.getByRole>[0], { name }).first().click();
    } else if (label) {
      await page.getByLabel(label).first().click();
    } else if (text) {
      await page.getByText(text, { exact: false }).first().click();
    } else if (selector) {
      await page.locator(selector).first().click();
    } else {
      return { content: [{ type: 'text' as const, text: 'Error: provide role+name, label, text, or selector' }], isError: true };
    }
    await page.waitForLoadState('domcontentloaded', { timeout: 1000 }).catch(() => null);
    return { content: [{ type: 'text' as const, text: JSON.stringify({ status: 'clicked', url: page.url(), title: await page.title() }) }] };
  });

  server.registerTool('browser_fill', {
    description: 'Fill an input or textarea. Prefer label (getByLabel) over CSS selector — it matches how a human identifies the field and produces stable generated code.',
    inputSchema: {
      selector: z.string().optional().describe('CSS selector — fallback; prefer label'),
      label:    z.string().optional().describe('Visible label text of the field (e.g. "Experience Name") — fills via page.getByLabel()'),
      value:    z.string().describe('Value to fill into the field'),
    },
  }, async ({ selector, label, value }) => {
    const page = await getPage();
    if (label) {
      await page.getByLabel(label).fill(value);
      return { content: [{ type: 'text' as const, text: JSON.stringify({ status: 'filled', label, value }) }] };
    } else if (selector) {
      await page.fill(selector, value);
      return { content: [{ type: 'text' as const, text: JSON.stringify({ status: 'filled', selector, value }) }] };
    } else {
      return { content: [{ type: 'text' as const, text: 'Error: provide label or selector' }], isError: true };
    }
  });

  server.registerTool('browser_select', {
    description: 'Select an option in a <select> dropdown element.',
    inputSchema: {
      selector: z.string().describe('CSS selector of the select element'),
      value:    z.string().describe('Option value or visible label to select'),
    },
  }, async ({ selector, value }) => {
    const page = await getPage();
    await page.selectOption(selector, { label: value }).catch(() => page.selectOption(selector, { value }));
    return { content: [{ type: 'text' as const, text: JSON.stringify({ status: 'selected', selector, value }) }] };
  });

  server.registerTool('browser_press_key', {
    description: 'Press a keyboard key (e.g. Enter, Tab, Escape, ArrowDown).',
    inputSchema: {
      key:      z.string().describe('Key name such as Enter, Tab, Escape, ArrowDown, Space'),
      selector: z.string().optional().describe('Focus this element before pressing the key'),
    },
  }, async ({ key, selector }) => {
    const page = await getPage();
    if (selector) await page.focus(selector);
    await page.keyboard.press(key);
    return { content: [{ type: 'text' as const, text: JSON.stringify({ status: 'pressed', key }) }] };
  });

  server.registerTool('browser_hover', {
    description: 'Hover over an element to reveal tooltips, dropdowns, or hover states.',
    inputSchema: { selector: z.string().describe('CSS selector of the element to hover') },
  }, async ({ selector }) => {
    const page = await getPage();
    await page.hover(selector);
    return { content: [{ type: 'text' as const, text: JSON.stringify({ status: 'hovered', selector }) }] };
  });

  server.registerTool('browser_wait_for_selector', {
    description: 'Wait for an element to become visible on the page.',
    inputSchema: {
      selector: z.string().describe('CSS selector to wait for'),
      timeout:  z.number().optional().describe('Maximum wait time in ms (default: 10000)'),
      state:    z.enum(['visible', 'hidden', 'attached', 'detached']).optional().describe('Element state (default: visible)'),
    },
  }, async ({ selector, timeout = 10000, state = 'visible' }) => {
    const page = await getPage();
    try {
      await page.waitForSelector(selector, { timeout, state });
      return { content: [{ type: 'text' as const, text: JSON.stringify({ status: 'found', selector }) }] };
    } catch {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ status: 'timeout', selector }) }], isError: true };
    }
  });

  server.registerTool('browser_get_url', {
    description: 'Get the current page URL and title.',
    inputSchema: {},
  }, async () => {
    const page = await getPage();
    return { content: [{ type: 'text' as const, text: JSON.stringify({ url: page.url(), title: await page.title() }) }] };
  });

  server.registerTool('browser_go_back', {
    description: 'Navigate back to the previous page in browser history.',
    inputSchema: {},
  }, async () => {
    const page = await getPage();
    await page.goBack({ waitUntil: 'domcontentloaded' });
    return { content: [{ type: 'text' as const, text: JSON.stringify({ url: page.url(), title: await page.title() }) }] };
  });

  server.registerTool('browser_check', {
    description: 'Check or uncheck a checkbox or radio button.',
    inputSchema: {
      selector: z.string().describe('CSS selector of the checkbox or radio'),
      checked:  z.boolean().optional().describe('true to check, false to uncheck (default: true)'),
    },
  }, async ({ selector, checked = true }) => {
    const page = await getPage();
    if (checked) await page.check(selector); else await page.uncheck(selector);
    return { content: [{ type: 'text' as const, text: JSON.stringify({ status: checked ? 'checked' : 'unchecked', selector }) }] };
  });

  server.registerTool('browser_evaluate', {
    description: 'Run a JavaScript expression in the page context and return its result.',
    inputSchema: { expression: z.string().describe('JavaScript expression to evaluate') },
  }, async ({ expression }) => {
    const page   = await getPage();
    const result = await page.evaluate(expression);
    return { content: [{ type: 'text' as const, text: JSON.stringify({ result }) }] };
  });

  server.registerTool('browser_scroll', {
    description: 'Scroll the page by pixel offset or scroll a specific element into view.',
    inputSchema: {
      selector: z.string().optional().describe('CSS selector to scroll into view'),
      x:        z.number().optional().describe('Horizontal scroll offset in pixels'),
      y:        z.number().optional().describe('Vertical scroll offset in pixels'),
    },
  }, async ({ selector, x = 0, y = 0 }) => {
    const page = await getPage();
    if (selector) {
      await page.locator(selector).first().scrollIntoViewIfNeeded();
    } else {
      await page.evaluate(([px, py]: [number, number]) => window.scrollBy(px, py), [x, y] as [number, number]);
    }
    return { content: [{ type: 'text' as const, text: JSON.stringify({ status: 'scrolled', selector: selector ?? null, x, y }) }] };
  });

  server.registerTool('browser_double_click', {
    description: 'Double-click an element.',
    inputSchema: { selector: z.string().describe('CSS selector of the element to double-click') },
  }, async ({ selector }) => {
    const page = await getPage();
    await page.dblclick(selector);
    await page.waitForLoadState('domcontentloaded').catch(() => null);
    return { content: [{ type: 'text' as const, text: JSON.stringify({ status: 'double-clicked', selector }) }] };
  });

  server.registerTool('browser_get_attribute', {
    description: 'Read the value of a specific HTML attribute from an element.',
    inputSchema: {
      selector:  z.string().describe('CSS selector of the element'),
      attribute: z.string().describe('Attribute name to read (e.g. value, href, aria-label, data-testid)'),
    },
  }, async ({ selector, attribute }) => {
    const page  = await getPage();
    const value = await page.getAttribute(selector, attribute);
    return { content: [{ type: 'text' as const, text: JSON.stringify({ selector, attribute, value }) }] };
  });

  server.registerTool('browser_wait_for_url', {
    description: 'Wait for the page URL to match a string pattern or regex.',
    inputSchema: {
      pattern: z.string().describe('URL substring or regex pattern to wait for'),
      timeout: z.number().optional().describe('Maximum wait time in ms (default: 15000)'),
    },
  }, async ({ pattern, timeout = 15000 }) => {
    const page = await getPage();
    try {
      await page.waitForURL(new RegExp(pattern), { timeout });
      return { content: [{ type: 'text' as const, text: JSON.stringify({ status: 'matched', url: page.url() }) }] };
    } catch {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ status: 'timeout', currentUrl: page.url(), pattern }) }], isError: true };
    }
  });

  server.registerTool('browser_upload_file', {
    description: 'Set files on a file input element.',
    inputSchema: {
      selector: z.string().describe('CSS selector of the file input element'),
      filePath: z.string().describe('Absolute path to the file to upload'),
    },
  }, async ({ selector, filePath }) => {
    const page = await getPage();
    await page.setInputFiles(selector, filePath);
    return { content: [{ type: 'text' as const, text: JSON.stringify({ status: 'uploaded', selector, filePath }) }] };
  });

  server.registerTool('browser_type', {
    description: 'Type text into an element character by character (use for elements that do not support fill).',
    inputSchema: {
      selector: z.string().describe('CSS selector of the element'),
      text:     z.string().describe('Text to type'),
      delay:    z.number().optional().describe('Delay between keystrokes in ms (default: 50)'),
    },
  }, async ({ selector, text, delay = 50 }) => {
    const page = await getPage();
    await page.locator(selector).type(text, { delay });
    return { content: [{ type: 'text' as const, text: JSON.stringify({ status: 'typed', selector, text }) }] };
  });

  server.registerTool('browser_clear', {
    description: 'Clear the value of an input field.',
    inputSchema: { selector: z.string().describe('CSS selector of the input field') },
  }, async ({ selector }) => {
    const page = await getPage();
    await page.fill(selector, '');
    return { content: [{ type: 'text' as const, text: JSON.stringify({ status: 'cleared', selector }) }] };
  });

  server.registerTool('browser_get_text', {
    description: 'Get the visible text content of an element.',
    inputSchema: { selector: z.string().describe('CSS selector of the element') },
  }, async ({ selector }) => {
    const page = await getPage();
    const text = await page.textContent(selector);
    return { content: [{ type: 'text' as const, text: JSON.stringify({ selector, text }) }] };
  });

  server.registerTool('browser_query_semantic', {
    description: 'Verify a Playwright semantic locator (getByRole, getByLabel, getByPlaceholder, getByText) and return match count. Use this BEFORE writing any semantic locator in generated code. count=1 + unique=true means the locator is safe to use.',
    inputSchema: {
      strategy: z.enum(['role', 'label', 'placeholder', 'text']).describe('Locator strategy: role=getByRole, label=getByLabel, placeholder=getByPlaceholder, text=getByText'),
      value:    z.string().describe('The accessible name / label text / placeholder / visible text to match'),
      role:     z.string().optional().describe('ARIA role — required when strategy="role" (e.g. button, textbox, checkbox, tab, combobox, dialog, menuitem, link)'),
      exact:    z.boolean().optional().describe('Exact match (default: false for partial match)'),
    },
  }, async ({ strategy, value, role, exact = false }) => {
    const page = await getPage();
    let locator: Locator;
    let locatorStr: string;

    switch (strategy) {
      case 'role':
        if (!role) return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'role param required when strategy="role"' }) }], isError: true };
        locator    = page.getByRole(role as Parameters<typeof page.getByRole>[0], { name: value, exact });
        locatorStr = `page.getByRole('${role}', { name: '${value}'${exact ? ', exact: true' : ''} })`;
        break;
      case 'label':
        locator    = page.getByLabel(value, { exact });
        locatorStr = `page.getByLabel('${value}'${exact ? ', { exact: true }' : ''})`;
        break;
      case 'placeholder':
        locator    = page.getByPlaceholder(value, { exact });
        locatorStr = `page.getByPlaceholder('${value}'${exact ? ', { exact: true }' : ''})`;
        break;
      case 'text':
        locator    = page.getByText(value, { exact });
        locatorStr = `page.getByText('${value}'${exact ? ', { exact: true }' : ''})`;
        break;
      default:
        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'unknown strategy' }) }], isError: true };
    }

    const count    = await locator!.count();
    const elements: Array<Record<string, unknown>> = [];
    for (let i = 0; i < Math.min(count, 5); i++) {
      try {
        const el      = locator!.nth(i);
        const visible  = await el.isVisible().catch(() => false);
        const disabled = await el.isDisabled().catch(() => false);
        const text     = ((await el.textContent().catch(() => '')) ?? '').trim().slice(0, 80);
        elements.push({ index: i, visible, disabled, text });
      } catch { /* skip */ }
    }

    const recommendation = count === 0
      ? '❌ NOT FOUND — try partial match (exact:false), different strategy, or check page state'
      : count === 1
      ? '✅ UNIQUE — safe to use in generated code'
      : `⚠ NOT UNIQUE (${count} matches) — add exact:true, scope to container, or pick different strategy`;

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          count,
          unique:            count === 1,
          playwrightLocator: locatorStr!,
          recommendation,
          elements,
        }, null, 2),
      }],
    };
  });

  server.registerTool('browser_get_form_map', {
    description: 'Extract the semantic map of all form fields and buttons, grouped by their nearest section heading. Shows exactly what a human reads when looking at a form — visible label, section context, type, and the ready Playwright locator. Use at the start of any form interaction and whenever a label is ambiguous (e.g. "Name" appears in multiple sections).',
    inputSchema: {
      selector: z.string().optional().describe('Scope to a container (e.g. \'[role="dialog"]\' for modals). Omit for full page.'),
    },
  }, async ({ selector }) => {
    const page    = await getPage();
    const formMap = await page.evaluate((containerSel: string | null) => {
      const root = (containerSel ? document.querySelector(containerSel) : document.body) as HTMLElement | null;
      if (!root) return { error: `Container "${containerSel}" not found`, sections: [] };

      // ── Label resolution ──────────────────────────────────────────────────
      function getLabel(el: HTMLElement): string {
        const aria = el.getAttribute('aria-label');
        if (aria) return aria;
        const lby = el.getAttribute('aria-labelledby');
        if (lby) {
          const t = lby.split(/\s+/).map(id => document.getElementById(id)?.textContent?.trim()).filter(Boolean).join(' ');
          if (t) return t;
        }
        if (el.id) {
          const lbl = document.querySelector(`label[for="${el.id}"]`);
          if (lbl) {
            const c = lbl.cloneNode(true) as HTMLElement;
            c.querySelectorAll('input,select,textarea,button,span.required,span.asterisk').forEach(ch => ch.remove());
            const t = c.textContent?.trim() || '';
            if (t) return t;
          }
        }
        let p = el.parentElement;
        let depth = 0;
        while (p && p !== root && depth < 6) {
          if (p.tagName === 'LABEL') {
            const c = p.cloneNode(true) as HTMLElement;
            c.querySelectorAll('input,select,textarea,button').forEach(ch => ch.remove());
            const t = c.textContent?.trim() || '';
            if (t) return t;
          }
          p = p.parentElement;
          depth++;
        }
        return '';
      }

      // ── Nearest section heading ───────────────────────────────────────────
      // Walk up the DOM to find the closest preceding heading or labelled container.
      function getNearestSection(el: HTMLElement): string {
        // 1. Check if inside a dialog / role-labelled region
        let p = el.parentElement;
        while (p && p !== root) {
          const role = p.getAttribute('role') || '';
          if (['dialog', 'region', 'tabpanel', 'group', 'fieldset'].includes(role)) {
            const regionLabel =
              p.getAttribute('aria-label') ||
              (p.getAttribute('aria-labelledby') ? document.getElementById(p.getAttribute('aria-labelledby')!)?.textContent?.trim() : null) ||
              p.querySelector('legend,h1,h2,h3,h4,h5,h6,[role="heading"]')?.textContent?.trim();
            if (regionLabel) return regionLabel;
          }
          if (p.tagName === 'FIELDSET') {
            const legend = p.querySelector('legend');
            if (legend) return legend.textContent?.trim() || '';
          }
          p = p.parentElement;
        }

        // 2. Walk the flattened document order to find the closest PRECEDING heading
        const headingTags = new Set(['H1','H2','H3','H4','H5','H6']);
        const allNodes = Array.from(root.querySelectorAll('*'));
        const elIdx    = allNodes.indexOf(el);
        for (let i = elIdx - 1; i >= 0; i--) {
          const node = allNodes[i] as HTMLElement;
          if (headingTags.has(node.tagName) || node.getAttribute('role') === 'heading') {
            const t = node.textContent?.trim() || '';
            if (t) return t;
          }
        }
        return '(page)';
      }

      // ── Playwright locator builder ────────────────────────────────────────
      function buildLocator(el: HTMLElement, label: string, section: string): string {
        const ph   = el.getAttribute('placeholder') || '';
        const tid  = el.getAttribute('data-testid') || '';
        const role = el.getAttribute('role') || '';
        const safe = (s: string) => s.replace(/'/g, "\\'");

        if (label) {
          // If the same label exists in multiple sections we need a scoped locator
          const sameLabels = Array.from(root!.querySelectorAll('input,textarea,select,[role="combobox"]'))
            .filter(e2 => getLabel(e2 as HTMLElement) === label);
          if (sameLabels.length > 1 && section !== '(page)') {
            return `page.getByRole('group', { name: '${safe(section)}' }).getByLabel('${safe(label)}')`;
          }
          return `page.getByLabel('${safe(label)}')`;
        }
        if (ph)  return `page.getByPlaceholder('${safe(ph)}')`;
        if (tid) return `page.locator('[data-testid="${safe(tid)}"]')`;
        if (role === 'combobox') return `page.locator('[role="combobox"]')  // ⚠ scope further`;
        return `page.locator('${el.tagName.toLowerCase()}')  // ⚠ not unique`;
      }

      // ── Collect all interactive elements ─────────────────────────────────
      const inputSel = 'input:not([type="hidden"]),textarea,select,[role="combobox"],[role="spinbutton"],[role="slider"]';
      const btnSel   = 'button,[role="button"],[type="submit"],[type="button"]';

      // Group by section
      const sectionMap = new Map<string, { fields: Record<string,unknown>[]; buttons: Record<string,unknown>[] }>();
      const seenKeys   = new Set<string>();

      for (const el of Array.from(root.querySelectorAll(inputSel)).slice(0, 60)) {
        const e     = el as HTMLElement;
        const rect  = e.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) continue;

        const label   = getLabel(e);
        const section = getNearestSection(e);
        const key     = `${section}::${label || e.getAttribute('placeholder') || e.id}`;
        if (seenKeys.has(key)) continue;
        seenKeys.add(key);

        if (!sectionMap.has(section)) sectionMap.set(section, { fields: [], buttons: [] });

        const entry: Record<string, unknown> = {
          label:             label || '(no label)',
          type:              e.getAttribute('type') || e.tagName.toLowerCase(),
          playwrightLocator: buildLocator(e, label, section),
        };
        const ph  = e.getAttribute('placeholder');
        const req = e.hasAttribute('required') || e.getAttribute('aria-required') === 'true';
        const dis = (e as HTMLInputElement).disabled;
        const val = (e as HTMLInputElement).value;
        if (ph)  entry.placeholder  = ph;
        if (req) entry.required     = true;
        if (dis) entry.disabled     = true;
        if (val) entry.currentValue = val;
        sectionMap.get(section)!.fields.push(entry);
      }

      for (const el of Array.from(root.querySelectorAll(btnSel)).slice(0, 30)) {
        const e    = el as HTMLElement;
        const rect = e.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) continue;

        const ariaLabel = e.getAttribute('aria-label') || '';
        const text      = (e.textContent?.trim() || '').slice(0, 60);
        const name      = ariaLabel || text;
        if (!name) continue;

        const section = getNearestSection(e);
        const key     = `${section}::btn::${name}`;
        if (seenKeys.has(key)) continue;
        seenKeys.add(key);

        if (!sectionMap.has(section)) sectionMap.set(section, { fields: [], buttons: [] });

        const safe  = (s: string) => s.replace(/'/g, "\\'");
        const entry: Record<string, unknown> = {
          label:             name,
          playwrightLocator: `page.getByRole('button', { name: '${safe(name)}' })`,
        };
        if ((e as HTMLButtonElement).disabled) entry.disabled = true;
        sectionMap.get(section)!.buttons.push(entry);
      }

      const sections = Array.from(sectionMap.entries()).map(([heading, content]) => ({
        section: heading,
        fields:  content.fields,
        buttons: content.buttons,
      }));

      return { url: window.location.href, totalFields: seenKeys.size, sections };
    }, selector ?? null);

    return { content: [{ type: 'text' as const, text: JSON.stringify(formMap, null, 2) }] };
  });

  // ── browser_get_element_context ───────────────────────────────────────────
  server.registerTool('browser_get_element_context', {
    description: 'Get the human-readable context around an element: nearest section heading, container role, sibling labels, and breadcrumb path. Use when multiple elements share the same label (e.g. "Name" appears in 3 sections) to determine which one belongs to a specific form step.',
    inputSchema: {
      selector: z.string().describe('CSS selector for the ambiguous element (or one specific match, e.g. "input[placeholder=\'Enter name\']").'),
      matchIndex: z.number().optional().describe('0-based index when the selector matches multiple elements. Omit to get context for all matches.'),
    },
  }, async ({ selector, matchIndex }) => {
    const page = await getPage();
    const result = await page.evaluate(({ sel, idx }: { sel: string; idx: number | null }) => {
      const allMatches = Array.from(document.querySelectorAll(sel)) as HTMLElement[];
      if (allMatches.length === 0) return { error: `No elements found for selector: ${sel}` };

      const targets = idx !== null ? [allMatches[idx]].filter(Boolean) : allMatches;
      if (targets.length === 0) return { error: `matchIndex ${idx} out of range (${allMatches.length} matches)` };

      function getLabel(el: HTMLElement): string {
        const aria = el.getAttribute('aria-label');
        if (aria) return aria;
        const lby = el.getAttribute('aria-labelledby');
        if (lby) {
          const t = lby.split(/\s+/).map(id => document.getElementById(id)?.textContent?.trim()).filter(Boolean).join(' ');
          if (t) return t;
        }
        if (el.id) {
          const lbl = document.querySelector(`label[for="${el.id}"]`);
          if (lbl) {
            const c = lbl.cloneNode(true) as HTMLElement;
            c.querySelectorAll('input,select,textarea,button').forEach(ch => ch.remove());
            const t = c.textContent?.trim() || '';
            if (t) return t;
          }
        }
        let p = el.parentElement;
        let depth = 0;
        while (p && depth < 6) {
          if (p.tagName === 'LABEL') {
            const c = p.cloneNode(true) as HTMLElement;
            c.querySelectorAll('input,select,textarea,button').forEach(ch => ch.remove());
            const t = c.textContent?.trim() || '';
            if (t) return t;
          }
          p = p.parentElement;
          depth++;
        }
        return '';
      }

      function breadcrumb(el: HTMLElement): string[] {
        const crumbs: string[] = [];
        let p = el.parentElement;
        while (p && p !== document.body) {
          const role = p.getAttribute('role') || p.tagName.toLowerCase();
          const ariaLabel =
            p.getAttribute('aria-label') ||
            (p.getAttribute('aria-labelledby')
              ? document.getElementById(p.getAttribute('aria-labelledby')!)?.textContent?.trim()
              : null);
          const legend = p.tagName === 'FIELDSET' ? p.querySelector('legend')?.textContent?.trim() : null;
          const heading = p.querySelector(':scope > h1,:scope > h2,:scope > h3,:scope > h4,:scope > h5,:scope > h6')?.textContent?.trim();
          const label = ariaLabel || legend || heading;
          if (label) crumbs.unshift(`${role}[${label}]`);
          else if (['dialog','main','aside','nav','section','article','form','fieldset'].includes(p.tagName.toLowerCase()) ||
                   ['dialog','region','tabpanel','group'].includes(role)) {
            crumbs.unshift(role);
          }
          p = p.parentElement;
        }
        return crumbs;
      }

      function nearestHeading(el: HTMLElement): string {
        const headingTags = new Set(['H1','H2','H3','H4','H5','H6']);
        const allNodes = Array.from(document.querySelectorAll('*'));
        const elIdx    = allNodes.indexOf(el);
        for (let i = elIdx - 1; i >= 0; i--) {
          const node = allNodes[i] as HTMLElement;
          if (headingTags.has(node.tagName) || node.getAttribute('role') === 'heading') {
            const t = node.textContent?.trim() || '';
            if (t) return t;
          }
        }
        return '(none)';
      }

      function siblingLabels(el: HTMLElement): string[] {
        const container = el.closest('[role="dialog"],[role="region"],[role="group"],fieldset,form,section') || el.parentElement;
        if (!container) return [];
        const siblings = Array.from(container.querySelectorAll('input,textarea,select,[role="combobox"]')) as HTMLElement[];
        return siblings
          .filter(s => s !== el)
          .map(s => getLabel(s))
          .filter(Boolean)
          .slice(0, 10);
      }

      return targets.map((el, i) => {
        const label     = getLabel(el);
        const section   = nearestHeading(el);
        const path      = breadcrumb(el);
        const siblings  = siblingLabels(el);
        const container = el.closest('[role="dialog"],[role="region"],[role="tabpanel"],[role="group"],fieldset') as HTMLElement | null;
        const containerRole  = container?.getAttribute('role') || container?.tagName.toLowerCase() || null;
        const containerLabel = container
          ? (container.getAttribute('aria-label') ||
             (container.getAttribute('aria-labelledby')
               ? document.getElementById(container.getAttribute('aria-labelledby')!)?.textContent?.trim()
               : null) ||
             container.querySelector('legend,h1,h2,h3,h4,h5,h6')?.textContent?.trim() ||
             null)
          : null;

        const ph  = el.getAttribute('placeholder') || null;
        const tid = el.getAttribute('data-testid') || null;
        const safe = (s: string) => s.replace(/'/g, "\\'");

        // Suggest a scoped locator if context is known
        let suggestedLocator = label ? `page.getByLabel('${safe(label)}')` : null;
        if (containerLabel && label) {
          suggestedLocator = `page.getByRole('${containerRole || 'group'}', { name: '${safe(containerLabel)}' }).getByLabel('${safe(label)}')`;
        } else if (section !== '(none)' && label) {
          suggestedLocator = `// Scope to section "${section}", then:\npage.getByLabel('${safe(label)}')`;
        }

        return {
          matchIndex: idx !== null ? idx : i,
          totalMatches: allMatches.length,
          label,
          nearestHeading: section,
          containerRole,
          containerLabel,
          breadcrumbPath: path,
          siblingFieldLabels: siblings,
          placeholder: ph,
          dataTestId: tid,
          suggestedLocator,
        };
      });
    }, { sel: selector, idx: matchIndex ?? null });

    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
  });

  const cleanup = async () => {
    if (state.page)    await state.page.close().catch(() => null);
    if (state.context) await state.context.close().catch(() => null);
    if (state.browser) await state.browser.close().catch(() => null);
  };

  return { server, cleanup };
}
