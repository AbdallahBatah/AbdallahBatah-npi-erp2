/**
 * Package 4 (deferred item, owner work cycle step 13): «إرسال أمر الشراء إلى
 * إيميل المورد». A minimal SMTP client on Node's own `net` / `tls`, because the
 * package registry is not reachable from where this was built and a mail
 * library could not be added. It covers what one company mailbox needs:
 * implicit TLS (465) or STARTTLS (587/25), AUTH LOGIN, one HTML message in
 * UTF-8 (base64), several recipients. No decorators here, so the file runs
 * under `node --experimental-strip-types` for a smoke test.
 */
import * as net from 'node:net';
import * as tls from 'node:tls';

export interface SmtpConfig {
  host: string;
  port: number;
  /** true = TLS from the first byte (port 465); false = plain, upgraded by STARTTLS when offered. */
  secure: boolean;
  user?: string;
  pass?: string;
  from: string;
  /** Refuse to send in clear text when STARTTLS is not offered (default true). */
  requireTls?: boolean;
  timeoutMs?: number;
}

export interface MailMessage {
  to: string[];
  cc?: string[];
  subject: string;
  html: string;
}

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');
const encodeHeader = (s: string) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${b64(s)}?=`);
const wrap76 = (s: string) => s.replace(/(.{76})/g, '$1\r\n');
const addr = (s: string) => {
  const m = /<([^>]+)>/.exec(s);
  return (m ? m[1] : s).trim();
};

/** The raw RFC 5322 message: headers, a blank line, a base64 HTML body. */
export function buildMessage(from: string, msg: MailMessage, date = new Date()): string {
  const headers = [
    `From: ${from}`,
    `To: ${msg.to.join(', ')}`,
    ...(msg.cc?.length ? [`Cc: ${msg.cc.join(', ')}`] : []),
    `Subject: ${encodeHeader(msg.subject)}`,
    `Date: ${date.toUTCString()}`,
    `Message-ID: <${date.getTime()}.${Math.random().toString(36).slice(2)}@${addr(from).split('@')[1] ?? 'localhost'}>`,
    'MIME-Version: 1.0',
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
  ];
  return `${headers.join('\r\n')}\r\n\r\n${wrap76(b64(msg.html))}\r\n`;
}

class Conversation {
  private buffer = '';
  private waiting: ((line: { code: number; text: string }) => void) | null = null;
  private failure: ((e: Error) => void) | null = null;
  private lines: string[] = [];

  socket: net.Socket | tls.TLSSocket;
  private readonly timeoutMs: number;

  constructor(socket: net.Socket | tls.TLSSocket, timeoutMs: number) {
    this.socket = socket;
    this.timeoutMs = timeoutMs;
    this.attach(socket);
  }

  attach(socket: net.Socket | tls.TLSSocket) {
    this.socket = socket;
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      this.buffer += chunk;
      let i: number;
      while ((i = this.buffer.indexOf('\r\n')) >= 0) {
        const line = this.buffer.slice(0, i);
        this.buffer = this.buffer.slice(i + 2);
        this.lines.push(line);
        // A reply ends on the line whose 4th character is a space ("250 OK"), not a hyphen ("250-SIZE").
        if (/^\d{3}( |$)/.test(line)) {
          const text = this.lines.join('\n');
          this.lines = [];
          const done = this.waiting;
          this.waiting = null;
          done?.({ code: Number(line.slice(0, 3)), text });
        }
      }
    });
    socket.on('error', (e) => this.failure?.(e));
  }

  reply(): Promise<{ code: number; text: string }> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('SMTP server did not answer in time')), this.timeoutMs);
      this.failure = (e) => {
        clearTimeout(timer);
        reject(e);
      };
      this.waiting = (r) => {
        clearTimeout(timer);
        resolve(r);
      };
    });
  }

  async send(line: string, expect: number[]): Promise<{ code: number; text: string }> {
    const answer = this.reply();
    this.socket.write(`${line}\r\n`);
    const r = await answer;
    if (!expect.includes(r.code)) {
      const shown = line.startsWith('AUTH') || /^[A-Za-z0-9+/=]+$/.test(line) ? '(credentials)' : line.split(' ')[0];
      throw new Error(`SMTP ${shown} refused: ${r.text}`);
    }
    return r;
  }
}

/** Sends one message; resolves with the server's final acceptance line. */
export async function sendMail(cfg: SmtpConfig, msg: MailMessage): Promise<string> {
  const timeoutMs = cfg.timeoutMs ?? 20000;
  const raw: net.Socket = cfg.secure
    ? tls.connect({ host: cfg.host, port: cfg.port, servername: cfg.host })
    : net.connect({ host: cfg.host, port: cfg.port });
  const c = new Conversation(raw, timeoutMs);
  try {
    const greeting = await c.reply();
    if (greeting.code !== 220) throw new Error(`SMTP greeting refused: ${greeting.text}`);
    const helloName = 'npi-erp.local';
    let ehlo = await c.send(`EHLO ${helloName}`, [250]);

    if (!cfg.secure) {
      if (/STARTTLS/i.test(ehlo.text)) {
        await c.send('STARTTLS', [220]);
        const upgraded = tls.connect({ socket: raw, servername: cfg.host });
        await new Promise<void>((resolve, reject) => {
          upgraded.once('secureConnect', () => resolve());
          upgraded.once('error', reject);
        });
        c.attach(upgraded);
        ehlo = await c.send(`EHLO ${helloName}`, [250]);
      } else if (cfg.requireTls !== false) {
        throw new Error('The SMTP server does not offer STARTTLS; refusing to send credentials in clear text');
      }
    }

    if (cfg.user) {
      await c.send('AUTH LOGIN', [334]);
      await c.send(b64(cfg.user), [334]);
      await c.send(b64(cfg.pass ?? ''), [235]);
    }
    await c.send(`MAIL FROM:<${addr(cfg.from)}>`, [250]);
    for (const r of [...msg.to, ...(msg.cc ?? [])]) await c.send(`RCPT TO:<${addr(r)}>`, [250, 251]);
    await c.send('DATA', [354]);
    const accepted = await c.send(`${buildMessage(cfg.from, msg)}\r\n.`, [250]);
    await c.send('QUIT', [221]).catch(() => undefined);
    return accepted.text;
  } finally {
    c.socket.end();
  }
}

/** Reads SMTP_* from the environment; null when mail is not configured. */
export function smtpFromEnv(env: NodeJS.ProcessEnv = process.env): SmtpConfig | null {
  if (!env.SMTP_HOST || !env.SMTP_FROM) return null;
  const port = Number(env.SMTP_PORT || 587);
  return {
    host: env.SMTP_HOST,
    port,
    secure: env.SMTP_SECURE ? env.SMTP_SECURE === 'true' : port === 465,
    user: env.SMTP_USER || undefined,
    pass: env.SMTP_PASS || undefined,
    from: env.SMTP_FROM,
    requireTls: env.SMTP_REQUIRE_TLS !== 'false',
  };
}
