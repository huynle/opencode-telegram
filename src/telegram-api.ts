/**
 * Telegram Bot API Client
 * 
 * Handles all communication with Telegram's Bot API
 */

export interface TelegramConfig {
  botToken: string
  chatId: string
  parseMode?: "Markdown" | "MarkdownV2" | "HTML"
}

export interface InlineKeyboardButton {
  text: string
  callback_data?: string
  url?: string
}

export interface SendMessageOptions {
  text: string
  chatId?: string
  parseMode?: "Markdown" | "MarkdownV2" | "HTML"
  disableNotification?: boolean
  replyMarkup?: {
    inline_keyboard: InlineKeyboardButton[][]
  }
}

export interface TelegramResponse<T = any> {
  ok: boolean
  result?: T
  description?: string
  error_code?: number
}

export interface Message {
  message_id: number
  chat: { id: number }
  text?: string
  date: number
}

export class TelegramClient {
  private baseUrl: string
  private defaultChatId: string
  private defaultParseMode: "Markdown" | "MarkdownV2" | "HTML"

  constructor(config: TelegramConfig) {
    this.baseUrl = `https://api.telegram.org/bot${config.botToken}`
    this.defaultChatId = config.chatId
    this.defaultParseMode = config.parseMode || "Markdown"
  }

  /**
   * Send a text message to Telegram
   */
  async sendMessage(options: SendMessageOptions): Promise<TelegramResponse<Message>> {
    const body: Record<string, any> = {
      chat_id: options.chatId || this.defaultChatId,
      text: options.text,
      parse_mode: options.parseMode || this.defaultParseMode,
    }

    if (options.disableNotification) {
      body.disable_notification = true
    }

    if (options.replyMarkup) {
      body.reply_markup = JSON.stringify(options.replyMarkup)
    }

    const response = await fetch(`${this.baseUrl}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })

    return response.json() as Promise<TelegramResponse<Message>>
  }

  /**
   * Send a message with inline keyboard buttons
   */
  async sendWithButtons(
    text: string,
    buttons: InlineKeyboardButton[][],
    options?: Partial<SendMessageOptions>
  ): Promise<TelegramResponse<Message>> {
    return this.sendMessage({
      text,
      replyMarkup: { inline_keyboard: buttons },
      ...options,
    })
  }

  /**
   * Answer a callback query (button click)
   */
  async answerCallbackQuery(
    callbackQueryId: string,
    options?: { text?: string; showAlert?: boolean }
  ): Promise<TelegramResponse<boolean>> {
    const body: Record<string, any> = {
      callback_query_id: callbackQueryId,
    }

    if (options?.text) body.text = options.text
    if (options?.showAlert) body.show_alert = true

    const response = await fetch(`${this.baseUrl}/answerCallbackQuery`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })

    return response.json() as Promise<TelegramResponse<boolean>>
  }

  /**
   * Edit an existing message
   */
  async editMessage(
    messageId: number,
    text: string,
    options?: { chatId?: string; replyMarkup?: { inline_keyboard: InlineKeyboardButton[][] } }
  ): Promise<TelegramResponse<Message>> {
    const body: Record<string, any> = {
      chat_id: options?.chatId || this.defaultChatId,
      message_id: messageId,
      text,
      parse_mode: this.defaultParseMode,
    }

    if (options?.replyMarkup) {
      body.reply_markup = JSON.stringify(options.replyMarkup)
    }

    const response = await fetch(`${this.baseUrl}/editMessageText`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })

    return response.json() as Promise<TelegramResponse<Message>>
  }

  /**
   * Set webhook URL for receiving updates
   */
  async setWebhook(url: string): Promise<TelegramResponse<boolean>> {
    const response = await fetch(`${this.baseUrl}/setWebhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    })

    return response.json() as Promise<TelegramResponse<boolean>>
  }

  /**
   * Delete webhook (switch to polling mode)
   */
  async deleteWebhook(): Promise<TelegramResponse<boolean>> {
    const response = await fetch(`${this.baseUrl}/deleteWebhook`, {
      method: "POST",
    })

    return response.json() as Promise<TelegramResponse<boolean>>
  }

  /**
   * Get webhook info
   */
  async getWebhookInfo(): Promise<TelegramResponse<any>> {
    const response = await fetch(`${this.baseUrl}/getWebhookInfo`)
    return response.json() as Promise<TelegramResponse<any>>
  }

  /**
   * Get bot info
   */
  async getMe(): Promise<TelegramResponse<any>> {
    const response = await fetch(`${this.baseUrl}/getMe`)
    return response.json() as Promise<TelegramResponse<any>>
  }

  /**
   * Get updates (for polling mode - useful for testing)
   */
  async getUpdates(offset?: number): Promise<TelegramResponse<any[]>> {
    const url = offset 
      ? `${this.baseUrl}/getUpdates?offset=${offset}` 
      : `${this.baseUrl}/getUpdates`
    const response = await fetch(url)
    return response.json() as Promise<TelegramResponse<any[]>>
  }
}

/**
 * Create a Telegram client from environment variables
 */
export function createTelegramClient(): TelegramClient {
  const botToken = process.env.TELEGRAM_BOT_TOKEN
  const chatId = process.env.TELEGRAM_CHAT_ID

  if (!botToken) {
    throw new Error("TELEGRAM_BOT_TOKEN environment variable is required")
  }
  if (!chatId) {
    throw new Error("TELEGRAM_CHAT_ID environment variable is required")
  }

  return new TelegramClient({ botToken, chatId })
}

/**
 * Escape special characters for MarkdownV2
 */
export function escapeMarkdownV2(text: string): string {
  return text.replace(/[_*\[\]()~`>#+\-=|{}.!\\]/g, "\\$&")
}

/**
 * Format a code block for Telegram
 */
export function codeBlock(code: string, language?: string): string {
  if (language) {
    return `\`\`\`${language}\n${code}\n\`\`\``
  }
  return `\`\`\`\n${code}\n\`\`\``
}
