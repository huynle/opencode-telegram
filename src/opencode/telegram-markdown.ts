/**
 * Markdown to Telegram HTML Converter
 * 
 * Converts GitHub-flavored Markdown from OpenCode responses to Telegram HTML.
 * Telegram HTML is more reliable than MarkdownV2 which requires extensive escaping.
 */

/**
 * Convert Markdown text to Telegram HTML format
 * 
 * Supported conversions:
 * - Code blocks (```lang...```) → <pre><code class="language-X">...</code></pre>
 * - Inline code (`code`) → <code>code</code>
 * - Bold (**text** or __text__) → <b>text</b>
 * - Italic (*text* or _text_) → <i>text</i>
 * - Strikethrough (~~text~~) → <s>text</s>
 * - Links [text](url) → <a href="url">text</a>
 * - Headers (# text) → <b>text</b> (Telegram doesn't support headers)
 */
export function markdownToTelegramHtml(markdown: string): string {
  if (!markdown) return ""

  let result = markdown

  // First, escape HTML entities in the source (before any conversion)
  // We need to be careful to only escape in non-code regions
  result = escapeHtmlPreservingCode(result)

  // Convert fenced code blocks (```lang\ncode\n```)
  // Must be done before inline code to avoid conflicts
  result = result.replace(
    /```(\w*)\n([\s\S]*?)```/g,
    (_, lang, code) => {
      // Unescape the code content since it was escaped above
      const unescapedCode = unescapeHtml(code.trim())
      // Re-escape just the code content for HTML
      const escapedCode = escapeHtml(unescapedCode)
      if (lang) {
        return `<pre><code class="language-${lang}">${escapedCode}</code></pre>`
      }
      return `<pre>${escapedCode}</pre>`
    }
  )

  // Convert inline code (`code`) - be careful not to match inside <pre> blocks
  result = convertInlineCode(result)

  // Convert bold (**text** or __text__)
  result = result.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
  result = result.replace(/__([^_]+)__/g, "<b>$1</b>")

  // Convert italic (*text* or _text_) - must come after bold
  // Be careful not to match underscores in the middle of words
  result = result.replace(/(?<![*\w])\*([^*]+)\*(?![*\w])/g, "<i>$1</i>")
  result = result.replace(/(?<![_\w])_([^_]+)_(?![_\w])/g, "<i>$1</i>")

  // Convert strikethrough (~~text~~)
  result = result.replace(/~~([^~]+)~~/g, "<s>$1</s>")

  // Convert links [text](url)
  result = result.replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    '<a href="$2">$1</a>'
  )

  // Convert headers (# Header) to bold - Telegram doesn't support headers
  result = result.replace(/^#{1,6}\s+(.+)$/gm, "<b>$1</b>")

  // Convert blockquotes (> text)
  result = result.replace(/^>\s+(.+)$/gm, "<blockquote>$1</blockquote>")

  return result
}

/**
 * Escape HTML entities, but preserve code blocks
 */
function escapeHtmlPreservingCode(text: string): string {
  // Split by code blocks, escape non-code parts, then rejoin
  const parts: string[] = []
  let lastIndex = 0
  
  // Match both fenced code blocks and inline code
  const codeBlockRegex = /```[\s\S]*?```|`[^`]+`/g
  let match: RegExpExecArray | null

  while ((match = codeBlockRegex.exec(text)) !== null) {
    // Escape the part before this code block
    if (match.index > lastIndex) {
      parts.push(escapeHtml(text.slice(lastIndex, match.index)))
    }
    // Keep the code block as-is (will be processed later)
    parts.push(match[0])
    lastIndex = match.index + match[0].length
  }

  // Escape any remaining text after the last code block
  if (lastIndex < text.length) {
    parts.push(escapeHtml(text.slice(lastIndex)))
  }

  return parts.join("")
}

/**
 * Convert inline code while avoiding already-converted <pre> blocks
 */
function convertInlineCode(text: string): string {
  const parts: string[] = []
  let lastIndex = 0

  // Find all <pre>...</pre> blocks to skip
  const preBlockRegex = /<pre>[\s\S]*?<\/pre>/g
  let match: RegExpExecArray | null

  while ((match = preBlockRegex.exec(text)) !== null) {
    // Process the part before this pre block
    if (match.index > lastIndex) {
      const beforePre = text.slice(lastIndex, match.index)
      // Convert inline code in this part
      parts.push(beforePre.replace(/`([^`]+)`/g, (_, code) => {
        const unescapedCode = unescapeHtml(code)
        return `<code>${escapeHtml(unescapedCode)}</code>`
      }))
    }
    // Keep the pre block as-is
    parts.push(match[0])
    lastIndex = match.index + match[0].length
  }

  // Process any remaining text after the last pre block
  if (lastIndex < text.length) {
    const remaining = text.slice(lastIndex)
    parts.push(remaining.replace(/`([^`]+)`/g, (_, code) => {
      const unescapedCode = unescapeHtml(code)
      return `<code>${escapeHtml(unescapedCode)}</code>`
    }))
  }

  return parts.join("")
}

/**
 * Escape HTML special characters
 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

/**
 * Unescape HTML entities
 */
function unescapeHtml(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
}

/**
 * Truncate text for Telegram's 4096 character limit
 * Preserves complete HTML tags at truncation point
 */
export function truncateForTelegram(html: string, maxLength = 4000): string {
  if (html.length <= maxLength) return html

  // Find a safe truncation point (not in the middle of a tag)
  let truncateAt = maxLength
  
  // Look for the last complete tag before maxLength
  const tagStart = html.lastIndexOf("<", maxLength)
  const tagEnd = html.lastIndexOf(">", maxLength)
  
  if (tagStart > tagEnd) {
    // We're in the middle of a tag, truncate before it
    truncateAt = tagStart
  }

  // Truncate and add ellipsis
  let truncated = html.slice(0, truncateAt)
  
  // Close any unclosed tags (simple check for common tags)
  const openTags: string[] = []
  const tagRegex = /<(\/?)(pre|code|b|i|s|a|blockquote)[^>]*>/gi
  let tagMatch: RegExpExecArray | null
  
  while ((tagMatch = tagRegex.exec(truncated)) !== null) {
    const isClosing = tagMatch[1] === "/"
    const tagName = tagMatch[2].toLowerCase()
    
    if (isClosing) {
      // Remove the matching open tag
      const idx = openTags.lastIndexOf(tagName)
      if (idx !== -1) {
        openTags.splice(idx, 1)
      }
    } else {
      openTags.push(tagName)
    }
  }

  // Close unclosed tags in reverse order
  for (let i = openTags.length - 1; i >= 0; i--) {
    truncated += `</${openTags[i]}>`
  }

  return truncated + "..."
}

/**
 * Check if text appears to contain Markdown formatting
 */
export function containsMarkdown(text: string): boolean {
  // Check for common Markdown patterns
  const patterns = [
    /```/,           // Code blocks
    /`[^`]+`/,       // Inline code
    /\*\*[^*]+\*\*/, // Bold
    /__[^_]+__/,     // Bold alt
    /\*[^*]+\*/,     // Italic
    /~~[^~]+~~/,     // Strikethrough
    /\[[^\]]+\]\([^)]+\)/, // Links
    /^#{1,6}\s/m,    // Headers
  ]
  
  return patterns.some(pattern => pattern.test(text))
}
