/**
 * Shop AI Chat - Client-side implementation
 *
 * This module handles the chat interface for the Shopify AI Chat application.
 * It manages the UI interactions, API communication, and message rendering.
 */
(function() {
  'use strict';

  const I18N = (window.shopChatConfig && window.shopChatConfig.i18n) ? window.shopChatConfig.i18n : {};
  const DEBUG = !!(window.shopChatConfig && window.shopChatConfig.debug);

  function debugLog(...args) {
    if (!DEBUG) return;
    // eslint-disable-next-line no-console
    console.log('[ShopAIChat]', ...args);
  }

  function debugWarn(...args) {
    if (!DEBUG) return;
    // eslint-disable-next-line no-console
    console.warn('[ShopAIChat]', ...args);
  }

  function debugError(...args) {
    if (!DEBUG) return;
    // eslint-disable-next-line no-console
    console.error('[ShopAIChat]', ...args);
  }

  /**
   * Simple i18n helper for user-visible strings.
   * @param {string} key
   * @param {string} fallback
   * @returns {string}
   */
  function t(key, fallback) {
    const value = I18N[key];
    return (typeof value === 'string' && value.length > 0) ? value : fallback;
  }

  /**
   * Very small template helper for strings like "Add {{title}} to my cart"
   * @param {string} str
   * @param {Record<string, string>} vars
   * @returns {string}
   */
  function template(str, vars) {
    if (typeof str !== 'string') return '';
    return str.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (match, key) => {
      if (Object.prototype.hasOwnProperty.call(vars, key)) return String(vars[key]);
      return match;
    });
  }

  const LOADING_HISTORY_TEXT = t('loadingHistory', 'Loading conversation history...');

  /**
   * Application namespace to prevent global scope pollution
   */
  const ShopAIChat = {
    /**
     * Lightweight in-memory state for the widget.
     */
    state: {
      lastProductResults: [],
    },

    /**
     * UI-related elements and functionality
     */
    UI: {
      elements: {},
      isMobile: false,

      /**
       * Initialize UI elements and event listeners
       * @param {HTMLElement} container - The main container element
       */
      init: function(container) {
        if (!container) return;

        // Cache DOM elements
        this.elements = {
          container: container,
          chatBubble: container.querySelector('.shop-ai-chat-bubble'),
          chatWindow: container.querySelector('.shop-ai-chat-window'),
          closeButton: container.querySelector('.shop-ai-chat-close'),
          chatInput: container.querySelector('.shop-ai-chat-input input'),
          sendButton: container.querySelector('.shop-ai-chat-send'),
          messagesContainer: container.querySelector('.shop-ai-chat-messages')
        };

        // Detect mobile device
        this.isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);

        // Set up event listeners
        this.setupEventListeners();

        // Fix for iOS Safari viewport height issues
        if (this.isMobile) {
          this.setupMobileViewport();
        }
      },

      /**
       * Set up all event listeners for UI interactions
       */
      setupEventListeners: function() {
        const { chatBubble, closeButton, chatInput, sendButton, messagesContainer } = this.elements;

        // Toggle chat window visibility
        chatBubble.addEventListener('click', () => this.toggleChatWindow());

        // Close chat window
        closeButton.addEventListener('click', () => this.closeChatWindow());

        // Send message when pressing Enter in input
        chatInput.addEventListener('keypress', (e) => {
          if (e.key === 'Enter' && chatInput.value.trim() !== '') {
            ShopAIChat.Message.send(chatInput, messagesContainer);

            // On mobile, handle keyboard
            if (this.isMobile) {
              chatInput.blur();
              setTimeout(() => chatInput.focus(), 300);
            }
          }
        });

        // Send message when clicking send button
        sendButton.addEventListener('click', () => {
          if (chatInput.value.trim() !== '') {
            ShopAIChat.Message.send(chatInput, messagesContainer);

            // On mobile, focus input after sending
            if (this.isMobile) {
              setTimeout(() => chatInput.focus(), 300);
            }
          }
        });

        // Handle window resize to adjust scrolling
        window.addEventListener('resize', () => this.scrollToBottom());

        // Add global click handler for auth links
        document.addEventListener('click', function(event) {
          if (event.target && event.target.classList.contains('shop-auth-trigger')) {
            event.preventDefault();
            if (window.shopAuthUrl) {
              ShopAIChat.Auth.openAuthPopup(window.shopAuthUrl);
            }
          }
        });
      },

      /**
       * Setup mobile-specific viewport adjustments
       */
      setupMobileViewport: function() {
        const setViewportHeight = () => {
          document.documentElement.style.setProperty('--viewport-height', `${window.innerHeight}px`);
        };
        window.addEventListener('resize', setViewportHeight);
        setViewportHeight();
      },

      /**
       * Toggle chat window visibility
       */
      toggleChatWindow: function() {
        const { chatWindow, chatInput } = this.elements;

        chatWindow.classList.toggle('active');

        if (chatWindow.classList.contains('active')) {
          // On mobile, prevent body scrolling and delay focus
          if (this.isMobile) {
            document.body.classList.add('shop-ai-chat-open');
            setTimeout(() => chatInput.focus(), 500);
          } else {
            chatInput.focus();
          }
          // Always scroll messages to bottom when opening
          this.scrollToBottom();
        } else {
          // Remove body class when closing
          document.body.classList.remove('shop-ai-chat-open');
        }
      },

      /**
       * Close chat window
       */
      closeChatWindow: function() {
        const { chatWindow, chatInput } = this.elements;

        chatWindow.classList.remove('active');

        // On mobile, blur input to hide keyboard and enable body scrolling
        if (this.isMobile) {
          chatInput.blur();
          document.body.classList.remove('shop-ai-chat-open');
        }
      },

      /**
       * Scroll messages container to bottom
       */
      scrollToBottom: function() {
        const { messagesContainer } = this.elements;
        setTimeout(() => {
          messagesContainer.scrollTop = messagesContainer.scrollHeight;
        }, 100);
      },

      /**
       * Show typing indicator in the chat
       */
      showTypingIndicator: function() {
        const { messagesContainer } = this.elements;

        const typingIndicator = document.createElement('div');
        typingIndicator.classList.add('shop-ai-typing-indicator');
        typingIndicator.innerHTML = '<span></span><span></span><span></span>';
        messagesContainer.appendChild(typingIndicator);
        this.scrollToBottom();
      },

      /**
       * Remove typing indicator from the chat
       */
      removeTypingIndicator: function() {
        const { messagesContainer } = this.elements;

        const typingIndicator = messagesContainer.querySelector('.shop-ai-typing-indicator');
        if (typingIndicator) {
          typingIndicator.remove();
        }
      },

      /**
       * Display product results in the chat
       * @param {Array} products - Array of product data objects
       * @param {Object} [options]
       * @param {boolean} [options.storeAsLastResults=true] - Whether to store these as the last selectable results
       */
      displayProductResults: function(products, options) {
        const { messagesContainer } = this.elements;
        const storeAsLastResults = !(options && options.storeAsLastResults === false);

        // Create a wrapper for the product section
        const productSection = document.createElement('div');
        productSection.classList.add('shop-ai-product-section');
        messagesContainer.appendChild(productSection);

        // Add a header for the product results
        const header = document.createElement('div');
        header.classList.add('shop-ai-product-header');
        header.innerHTML = `<h4>${t('productTopMatching', 'Top Matching Products')}</h4>`;
        productSection.appendChild(header);

        // Create the product grid container
        const productsContainer = document.createElement('div');
        productsContainer.classList.add('shop-ai-product-grid');
        productSection.appendChild(productsContainer);

        if (!products || !Array.isArray(products) || products.length === 0) {
          const noProductsMessage = document.createElement('p');
          noProductsMessage.textContent = t('productNoneFound', 'No products found');
          noProductsMessage.style.padding = "10px";
          productsContainer.appendChild(noProductsMessage);
        } else {
          if (storeAsLastResults) {
            ShopAIChat.state.lastProductResults = products;
            debugLog('Stored lastProductResults', { count: products.length });

            // Persist across reloads so selection like "the second one" works reliably.
            try {
              sessionStorage.setItem('shopAiLastProductResults', JSON.stringify(products));
            } catch (e) {
              debugWarn('Unable to persist lastProductResults to sessionStorage', e);
            }
          }

          products.forEach(product => {
            const productCard = ShopAIChat.Product.createCard(product);
            productsContainer.appendChild(productCard);
          });
        }

        this.scrollToBottom();
      }
    },

    /**
     * Message handling and display functionality
     */
    Message: {
      /**
       * Send a message to the API
       * @param {HTMLInputElement} chatInput - The input element
       * @param {HTMLElement} messagesContainer - The messages container
       */
      send: async function(chatInput, messagesContainer) {
        const userMessage = chatInput.value.trim();
        const conversationId = sessionStorage.getItem('shopAiConversationId');

        // Add user message to chat
        this.add(userMessage, 'user', messagesContainer);

        // Clear input
        chatInput.value = '';

        // Show typing indicator
        ShopAIChat.UI.showTypingIndicator();

        try {
          // If we don't currently have last results in memory, try restoring them before parsing selection.
          if (!Array.isArray(ShopAIChat.state.lastProductResults) || ShopAIChat.state.lastProductResults.length === 0) {
            try {
              const persisted = sessionStorage.getItem('shopAiLastProductResults');
              if (persisted) {
                const parsed = JSON.parse(persisted);
                if (Array.isArray(parsed) && parsed.length > 0) {
                  ShopAIChat.state.lastProductResults = parsed;
                  debugLog('Restored lastProductResults from sessionStorage (on send)', { count: parsed.length });
                }
              }
            } catch (e) {
              debugWarn('Unable to restore lastProductResults from sessionStorage (on send)', e);
            }
          }

          // If the user picks "the 2nd one" from the last product results, render that product card locally.
          const selectionIndex = ShopAIChat.Selection
            ? ShopAIChat.Selection.parseSelectedIndex(userMessage, ShopAIChat.state.lastProductResults?.length || 0)
            : null;

          if (selectionIndex !== null && selectionIndex !== undefined) {
            debugLog('Product selection detected', { userMessage, selectionIndex });
            await ShopAIChat.Selection.handleSelection(selectionIndex, messagesContainer);
            return;
          }

          // If the user is asking about their cart, answer locally using Online Store cart (/cart.js)
          if (ShopAIChat.Cart && ShopAIChat.Cart.isCartQuery(userMessage)) {
            debugLog('Cart query detected; answering via /cart.js', { userMessage });
            await ShopAIChat.Cart.handleCartQuery(messagesContainer);
            return;
          }

          debugLog('Sending message to backend', { userMessage, conversationId });
          ShopAIChat.API.streamResponse(userMessage, conversationId, messagesContainer);
        } catch (error) {
          debugError('Error communicating with Claude API:', error);
          ShopAIChat.UI.removeTypingIndicator();
          this.add(t('errorGeneric', "Sorry, I couldn't process your request at the moment. Please try again later."), 'assistant', messagesContainer);
        }
      },

      /**
       * Add a message to the chat
       * @param {string} text - Message content
       * @param {string} sender - Message sender ('user' or 'assistant')
       * @param {HTMLElement} messagesContainer - The messages container
       * @returns {HTMLElement} The created message element
       */
      add: function(text, sender, messagesContainer) {
        const messageElement = document.createElement('div');
        messageElement.classList.add('shop-ai-message', sender);

        if (sender === 'assistant') {
          messageElement.dataset.rawText = text;
          ShopAIChat.Formatting.formatMessageContent(messageElement);
        } else {
          messageElement.textContent = text;
        }

        messagesContainer.appendChild(messageElement);
        ShopAIChat.UI.scrollToBottom();

        return messageElement;
      },

      /**
       * Add a tool use message to the chat with expandable arguments
       * @param {string} toolMessage - Tool use message content
       * @param {HTMLElement} messagesContainer - The messages container
       */
      addToolUse: function(toolMessage, messagesContainer) {
        // Parse the tool message to extract tool name and arguments
        const match = toolMessage.match(/Calling tool: (\w+) with arguments: (.+)/);
        if (!match) {
          // Fallback for unexpected format
          const toolUseElement = document.createElement('div');
          toolUseElement.classList.add('shop-ai-message', 'tool-use');
          toolUseElement.textContent = toolMessage;
          messagesContainer.appendChild(toolUseElement);
          ShopAIChat.UI.scrollToBottom();
          return;
        }

        const toolName = match[1];
        const argsString = match[2];

        // Create the main tool use element
        const toolUseElement = document.createElement('div');
        toolUseElement.classList.add('shop-ai-message', 'tool-use');

        // Create the header (always visible)
        const headerElement = document.createElement('div');
        headerElement.classList.add('shop-ai-tool-header');

        const toolText = document.createElement('span');
        toolText.classList.add('shop-ai-tool-text');
        toolText.textContent = `Calling tool: ${toolName}`;

        const toggleElement = document.createElement('span');
        toggleElement.classList.add('shop-ai-tool-toggle');
        toggleElement.textContent = '[+]';

        headerElement.appendChild(toolText);
        headerElement.appendChild(toggleElement);

        // Create the arguments section (initially hidden)
        const argsElement = document.createElement('div');
        argsElement.classList.add('shop-ai-tool-args');

        try {
          // Try to format JSON arguments nicely
          const parsedArgs = JSON.parse(argsString);
          argsElement.textContent = JSON.stringify(parsedArgs, null, 2);
        } catch (e) {
          // If not valid JSON, just show as-is
          argsElement.textContent = argsString;
        }

        // Add click handler to toggle arguments visibility
        headerElement.addEventListener('click', function() {
          const isExpanded = argsElement.classList.contains('expanded');
          if (isExpanded) {
            argsElement.classList.remove('expanded');
            toggleElement.textContent = '[+]';
          } else {
            argsElement.classList.add('expanded');
            toggleElement.textContent = '[-]';
          }
        });

        // Assemble the complete element
        toolUseElement.appendChild(headerElement);
        toolUseElement.appendChild(argsElement);

        messagesContainer.appendChild(toolUseElement);
        ShopAIChat.UI.scrollToBottom();
      }
    },

    /**
     * Selection helpers for "first/second/third..." messages based on the last displayed products.
     */
    Selection: {
      /**
       * Parse a user message like "the second one", "2", "deuxième", "2e", etc. into a 0-based index.
       * Returns null when not a selection.
       * @param {string} message
       * @param {number} max
       * @returns {number|null}
       */
      parseSelectedIndex: function(message, max) {
        if (typeof message !== 'string') return null;
        if (typeof max !== 'number' || max <= 0) return null;

        const raw = message.trim();
        if (!raw) return null;

        const m = raw.toLowerCase();

        // Numeric-only selections like "2"
        if (/^\d+$/.test(m)) {
          const n = Number(m);
          if (n >= 1 && n <= max) return n - 1;
          return null;
        }

        // "#2", "n° 2", "no 2", "numéro 2"
        const numericMatch = m.match(/\b(?:#|n°|no|num(?:ero|éro)?|number)\s*(\d+)\b/);
        if (numericMatch && numericMatch[1]) {
          const n = Number(numericMatch[1]);
          if (n >= 1 && n <= max) return n - 1;
        }

        // Ordinal words (EN/FR)
        const wordToIndex = {
          // English
          first: 0,
          '1st': 0,
          second: 1,
          '2nd': 1,
          third: 2,
          '3rd': 2,
          fourth: 3,
          '4th': 3,
          fifth: 4,
          '5th': 4,
          // French
          premier: 0,
          premiere: 0,
          '1er': 0,
          '1ère': 0,
          deuxieme: 1,
          '2e': 1,
          '2ème': 1,
          '2eme': 1,
          troisieme: 2,
          '3e': 2,
          '3ème': 2,
          '3eme': 2,
          quatrieme: 3,
          '4e': 3,
          '4ème': 3,
          '4eme': 3,
          cinquieme: 4,
          '5e': 4,
          '5ème': 4,
          '5eme': 4,
        };

        // Normalize accents for matching simple keys (best-effort)
        const normalized = m.normalize('NFD').replace(/[\u0300-\u036f]/g, '');

        const tokens = normalized.split(/[^a-z0-9]+/).filter(Boolean);
        for (const token of tokens) {
          if (Object.prototype.hasOwnProperty.call(wordToIndex, token)) {
            const idx = wordToIndex[token];
            if (idx >= 0 && idx < max) return idx;
            return null;
          }
        }

        // "last"/"final"/"dernier/derniere" selections
        if (tokens.includes('last') || tokens.includes('final') || tokens.includes('dernier') || tokens.includes('derniere')) {
          return max - 1;
        }

        return null;
      },

      /**
       * Render the selected product card and a short guidance message.
       * @param {number} index
       * @param {HTMLElement} messagesContainer
       */
      handleSelection: async function(index, messagesContainer) {
        ShopAIChat.UI.removeTypingIndicator();

        const products = Array.isArray(ShopAIChat.state.lastProductResults) ? ShopAIChat.state.lastProductResults : [];
        const product = products[index];

        if (!product) {
          ShopAIChat.Message.add(
            t('productSelectionOutOfRange', "I couldn't find that item in the list. Please pick 1, 2, or 3."),
            'assistant',
            messagesContainer
          );
          return;
        }

        // Show the selected product card (do not overwrite lastProductResults so user can pick again)
        ShopAIChat.UI.displayProductResults([product], { storeAsLastResults: false });

        const msgTemplate = t(
          'productSelectionMessage',
          "Here's **{{title}}** — click **Add to Cart** on the card to add it to your cart."
        );
        ShopAIChat.Message.add(
          template(msgTemplate, { title: product.title }),
          'assistant',
          messagesContainer
        );
      }
    },

    /**
     * Text formatting and markdown handling
     */
    Formatting: {
      /**
       * Format message content with markdown and links
       * @param {HTMLElement} element - The element to format
       */
      formatMessageContent: function(element) {
        if (!element || !element.dataset.rawText) return;

        const rawText = element.dataset.rawText;

        // Process the text with various Markdown features
        let processedText = rawText;

        // Process Markdown links
        const markdownLinkRegex = /\[([^\]]+)\]\(([^)]+)\)/g;
        processedText = processedText.replace(markdownLinkRegex, (match, text, url) => {
          // Check if it's an auth URL
          if (url.includes('shopify.com/authentication') &&
             (url.includes('oauth/authorize') || url.includes('authentication'))) {
            // Store the auth URL in a global variable for later use - this avoids issues with onclick handlers
            window.shopAuthUrl = url;
            // Just return normal link that will be handled by the document click handler
            return '<a href="#auth" class="shop-auth-trigger">' + text + '</a>';
          }
          // If it's a checkout link, replace the text
          else if (url.includes('/cart') || url.includes('checkout')) {
            return '<a href="' + url + '" target="_blank" rel="noopener noreferrer">' + t('checkoutLinkText', 'click here to proceed to checkout') + '</a>';
          } else {
            // For normal links, preserve the original text
            return '<a href="' + url + '" target="_blank" rel="noopener noreferrer">' + text + '</a>';
          }
        });

        // Convert text to HTML with proper list handling
        processedText = this.convertMarkdownToHtml(processedText);

        // Apply the formatted HTML
        element.innerHTML = processedText;
      },

      /**
       * Convert Markdown text to HTML with list support
       * @param {string} text - Markdown text to convert
       * @returns {string} HTML content
       */
      convertMarkdownToHtml: function(text) {
        text = text.replace(/(\*\*|__)(.*?)\1/g, '<strong>$2</strong>');
        const lines = text.split('\n');
        let currentList = null;
        let listItems = [];
        let htmlContent = '';
        let startNumber = 1;

        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          const unorderedMatch = line.match(/^\s*([-*])\s+(.*)/);
          const orderedMatch = line.match(/^\s*(\d+)[\.)]\s+(.*)/);

          if (unorderedMatch) {
            if (currentList !== 'ul') {
              if (currentList === 'ol') {
                htmlContent += `<ol start="${startNumber}">` + listItems.join('') + '</ol>';
                listItems = [];
              }
              currentList = 'ul';
            }
            listItems.push('<li>' + unorderedMatch[2] + '</li>');
          } else if (orderedMatch) {
            if (currentList !== 'ol') {
              if (currentList === 'ul') {
                htmlContent += '<ul>' + listItems.join('') + '</ul>';
                listItems = [];
              }
              currentList = 'ol';
              startNumber = parseInt(orderedMatch[1], 10);
            }
            listItems.push('<li>' + orderedMatch[2] + '</li>');
          } else {
            if (currentList) {
              htmlContent += currentList === 'ul'
                ? '<ul>' + listItems.join('') + '</ul>'
                : `<ol start="${startNumber}">` + listItems.join('') + '</ol>';
              listItems = [];
              currentList = null;
            }

            if (line.trim() === '') {
              htmlContent += '<br>';
            } else {
              htmlContent += '<p>' + line + '</p>';
            }
          }
        }

        if (currentList) {
          htmlContent += currentList === 'ul'
            ? '<ul>' + listItems.join('') + '</ul>'
            : `<ol start="${startNumber}">` + listItems.join('') + '</ol>';
        }

        htmlContent = htmlContent.replace(/<\/p><p>/g, '</p>\n<p>');
        return htmlContent;
      }
    },

    /**
     * API communication and data handling
     */
    API: {
      /**
       * Stream a response from the API
       * @param {string} userMessage - User's message text
       * @param {string} conversationId - Conversation ID for context
       * @param {HTMLElement} messagesContainer - The messages container
       */
      streamResponse: async function(userMessage, conversationId, messagesContainer) {
        let currentMessageElement = null;

        try {
          const promptType = window.shopChatConfig?.promptType || "standardAssistant";
          const requestBody = JSON.stringify({
            message: userMessage,
            conversation_id: conversationId,
            prompt_type: promptType
          });

          const streamUrl = 'https://localhost:3458/chat';
          const shopId = window.shopId;

          const response = await fetch(streamUrl, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Accept': 'text/event-stream',
              'X-Shopify-Shop-Id': shopId
            },
            body: requestBody
          });

          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let buffer = '';

          // Create initial message element
          let messageElement = document.createElement('div');
          messageElement.classList.add('shop-ai-message', 'assistant');
          messageElement.textContent = '';
          messageElement.dataset.rawText = '';
          messagesContainer.appendChild(messageElement);
          currentMessageElement = messageElement;

          // Process the stream
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
              if (line.startsWith('data: ')) {
                try {
                  const data = JSON.parse(line.slice(6));
                  this.handleStreamEvent(data, currentMessageElement, messagesContainer, userMessage,
                    (newElement) => { currentMessageElement = newElement; });
                } catch (e) {
                  console.error('Error parsing event data:', e, line);
                }
              }
            }
          }

          // Flush any remaining buffered event when the stream closes (prevents dropping the last message).
          if (buffer && buffer.trim().length > 0) {
            const trailing = buffer.split('\n\n').filter(Boolean);
            for (const line of trailing) {
              const trimmed = line.trimStart();
              if (trimmed.startsWith('data: ')) {
                try {
                  const data = JSON.parse(trimmed.slice(6));
                  this.handleStreamEvent(data, currentMessageElement, messagesContainer, userMessage,
                    (newElement) => { currentMessageElement = newElement; });
                } catch (e) {
                  console.error('Error parsing trailing event data:', e, line);
                }
              }
            }
          }
        } catch (error) {
          console.error('Error in streaming:', error);
          ShopAIChat.UI.removeTypingIndicator();
          ShopAIChat.Message.add(t('errorGeneric', "Sorry, I couldn't process your request. Please try again later."),
            'assistant', messagesContainer);
        }
      },

      /**
       * Handle stream events from the API
       * @param {Object} data - Event data
       * @param {HTMLElement} currentMessageElement - Current message element being updated
       * @param {HTMLElement} messagesContainer - The messages container
       * @param {string} userMessage - The original user message
       * @param {Function} updateCurrentElement - Callback to update the current element reference
       */
      handleStreamEvent: function(data, currentMessageElement, messagesContainer, userMessage, updateCurrentElement) {
        switch (data.type) {
          case 'id':
            if (data.conversation_id) {
              sessionStorage.setItem('shopAiConversationId', data.conversation_id);
            }
            break;

          case 'chunk':
            ShopAIChat.UI.removeTypingIndicator();
            currentMessageElement.dataset.rawText += data.chunk;
            currentMessageElement.textContent = currentMessageElement.dataset.rawText;
            ShopAIChat.UI.scrollToBottom();
            break;

          case 'message_complete':
            ShopAIChat.UI.removeTypingIndicator();
            ShopAIChat.Formatting.formatMessageContent(currentMessageElement);
            ShopAIChat.UI.scrollToBottom();
            break;

          case 'end_turn':
            ShopAIChat.UI.removeTypingIndicator();
            break;

          case 'error':
            console.error('Stream error:', data.error);
            ShopAIChat.UI.removeTypingIndicator();
            currentMessageElement.textContent = t('errorGeneric', "Sorry, I couldn't process your request. Please try again later.");
            break;

          case 'rate_limit_exceeded':
            console.error('Rate limit exceeded:', data.error);
            ShopAIChat.UI.removeTypingIndicator();
            currentMessageElement.textContent = t('errorBusy', "Sorry, our servers are currently busy. Please try again later.");
            break;

          case 'auth_required':
            // Save the last user message for resuming after authentication
            sessionStorage.setItem('shopAiLastMessage', userMessage || '');
            break;

          case 'product_results':
            debugLog('Received product_results', { count: Array.isArray(data.products) ? data.products.length : 0 });
            // Don't overwrite a multi-product list with a single-product widget (keeps ordinal selection reliable).
            if (Array.isArray(data.products) && data.products.length === 1 &&
                Array.isArray(ShopAIChat.state.lastProductResults) && ShopAIChat.state.lastProductResults.length > 1) {
              ShopAIChat.UI.displayProductResults(data.products, { storeAsLastResults: false });
            } else {
              ShopAIChat.UI.displayProductResults(data.products);
            }
            break;

          case 'tool_use':
            if (data.tool_use_message) {
              ShopAIChat.Message.addToolUse(data.tool_use_message, messagesContainer);
            }
            break;

          case 'new_message':
            ShopAIChat.Formatting.formatMessageContent(currentMessageElement);
            ShopAIChat.UI.showTypingIndicator();

            // Create new message element for the next response
            const newMessageElement = document.createElement('div');
            newMessageElement.classList.add('shop-ai-message', 'assistant');
            newMessageElement.textContent = '';
            newMessageElement.dataset.rawText = '';
            messagesContainer.appendChild(newMessageElement);

            // Update the current element reference
            updateCurrentElement(newMessageElement);
            break;

          case 'content_block_complete':
            ShopAIChat.UI.showTypingIndicator();
            break;
        }
      },

      /**
       * Fetch chat history from the server
       * @param {string} conversationId - Conversation ID
       * @param {HTMLElement} messagesContainer - The messages container
       */
      fetchChatHistory: async function(conversationId, messagesContainer) {
        try {
          // Show a loading message
          const loadingMessage = document.createElement('div');
          loadingMessage.classList.add('shop-ai-message', 'assistant');
          loadingMessage.textContent = LOADING_HISTORY_TEXT;
          messagesContainer.appendChild(loadingMessage);

          // Fetch history from the server
          const historyUrl = `https://localhost:3458/chat?history=true&conversation_id=${encodeURIComponent(conversationId)}`;
          console.log('Fetching history from:', historyUrl);

          const response = await fetch(historyUrl, {
            method: 'GET',
            headers: {
              'Accept': 'application/json',
              'Content-Type': 'application/json'
            },
            mode: 'cors'
          });

          if (!response.ok) {
            console.error('History fetch failed:', response.status, response.statusText);
            throw new Error('Failed to fetch chat history: ' + response.status);
          }

          const data = await response.json();

          // Remove loading message
          messagesContainer.removeChild(loadingMessage);

          // No messages, show welcome message
          if (!data.messages || data.messages.length === 0) {
            const welcomeMessage = window.shopChatConfig?.welcomeMessage || t('welcomeDefault', "👋 Hi there! How can I help you today?");
            ShopAIChat.Message.add(welcomeMessage, 'assistant', messagesContainer);
            return;
          }

          // Add messages to the UI - filter out tool results
          data.messages.forEach(message => {
            try {
              const messageContents = JSON.parse(message.content);
              for (const contentBlock of messageContents) {
                if (contentBlock.type === 'text') {
                  ShopAIChat.Message.add(contentBlock.text, message.role, messagesContainer);
                }
              }
            } catch (e) {
              ShopAIChat.Message.add(message.content, message.role, messagesContainer);
            }
          });

          // Scroll to bottom
          ShopAIChat.UI.scrollToBottom();

        } catch (error) {
          console.error('Error fetching chat history:', error);

          // Remove loading message if it exists
          const loadingMessage = messagesContainer.querySelector('.shop-ai-message.assistant');
          if (loadingMessage && loadingMessage.textContent === LOADING_HISTORY_TEXT) {
            messagesContainer.removeChild(loadingMessage);
          }

          // Show error and welcome message
          const welcomeMessage = window.shopChatConfig?.welcomeMessage || t('welcomeDefault', "👋 Hi there! How can I help you today?");
          ShopAIChat.Message.add(welcomeMessage, 'assistant', messagesContainer);

          // Clear the conversation ID since we couldn't fetch this conversation
          sessionStorage.removeItem('shopAiConversationId');
        }
      }
    },

    /**
     * Authentication-related functionality
     */
    Auth: {
      /**
       * Opens an authentication popup window
       * @param {string|HTMLElement} authUrlOrElement - The auth URL or link element that was clicked
       */
      openAuthPopup: function(authUrlOrElement) {
        let authUrl;
        if (typeof authUrlOrElement === 'string') {
          // If a string URL was passed directly
          authUrl = authUrlOrElement;
        } else {
          // If an element was passed
          authUrl = authUrlOrElement.getAttribute('data-auth-url');
          if (!authUrl) {
            console.error('No auth URL found in element');
            return;
          }
        }

        // Open the popup window centered in the screen
        const width = 600;
        const height = 700;
        const left = (window.innerWidth - width) / 2 + window.screenX;
        const top = (window.innerHeight - height) / 2 + window.screenY;

        const popup = window.open(
          authUrl,
          'ShopifyAuth',
          `width=${width},height=${height},left=${left},top=${top},resizable=yes,scrollbars=yes`
        );

        // Focus the popup window
        if (popup) {
          popup.focus();
        } else {
          // If popup was blocked, show a message
          alert(t('allowPopups', 'Please allow popups for this site to authenticate with Shopify.'));
        }

        // Start polling for token availability
        const conversationId = sessionStorage.getItem('shopAiConversationId');
        if (conversationId) {
          const messagesContainer = document.querySelector('.shop-ai-chat-messages');

          // Add a message to indicate authentication is in progress
          ShopAIChat.Message.add(t('authInProgress', "Authentication in progress. Please complete the process in the popup window."),
            'assistant', messagesContainer);

          this.startTokenPolling(conversationId, messagesContainer);
        }
      },

      /**
       * Start polling for token availability
       * @param {string} conversationId - Conversation ID
       * @param {HTMLElement} messagesContainer - The messages container
       */
      startTokenPolling: function(conversationId, messagesContainer) {
        if (!conversationId) return;

        console.log('Starting token polling for conversation:', conversationId);
        const pollingId = 'polling_' + Date.now();
        sessionStorage.setItem('shopAiTokenPollingId', pollingId);

        let attemptCount = 0;
        const maxAttempts = 30;

        const poll = async () => {
          if (sessionStorage.getItem('shopAiTokenPollingId') !== pollingId) {
            console.log('Another polling session has started, stopping this one');
            return;
          }

          if (attemptCount >= maxAttempts) {
            console.log('Max polling attempts reached, stopping');
            return;
          }

          attemptCount++;

          try {
            const tokenUrl = 'https://localhost:3458/auth/token-status?conversation_id=' +
              encodeURIComponent(conversationId);
            const response = await fetch(tokenUrl);

            if (!response.ok) {
              throw new Error('Token status check failed: ' + response.status);
            }

            const data = await response.json();

            if (data.status === 'authorized') {
              console.log('Token available, resuming conversation');
              const message = sessionStorage.getItem('shopAiLastMessage');

              if (message) {
                sessionStorage.removeItem('shopAiLastMessage');
                setTimeout(() => {
                  ShopAIChat.Message.add(t('authSuccessContinue', "Authorization successful! I'm now continuing with your request."),
                    'assistant', messagesContainer);
                  ShopAIChat.API.streamResponse(message, conversationId, messagesContainer);
                  ShopAIChat.UI.showTypingIndicator();
                }, 500);
              }

              sessionStorage.removeItem('shopAiTokenPollingId');
              return;
            }

            console.log('Token not available yet, polling again in 10s');
            setTimeout(poll, 10000);
          } catch (error) {
            console.error('Error polling for token status:', error);
            setTimeout(poll, 10000);
          }
        };

        setTimeout(poll, 2000);
      }
    },

    /**
     * Product-related functionality
     */
    Product: {
      /**
       * Extract a numeric variant id from various shapes:
       * - "gid://shopify/ProductVariant/123"
       * - "123"
       * - 123
       * @param {string|number|undefined|null} value
       * @returns {number|null}
       */
      _toNumericVariantId: function(value) {
        if (typeof value === 'number' && Number.isFinite(value)) return value;
        if (typeof value !== 'string') return null;

        const trimmed = value.trim();
        if (/^\d+$/.test(trimmed)) return Number(trimmed);

        const gidMatch = trimmed.match(/gid:\/\/shopify\/ProductVariant\/(\d+)/);
        if (gidMatch && gidMatch[1]) return Number(gidMatch[1]);

        return null;
      },

      /**
       * Add a variant to the Online Store cart using Shopify Ajax Cart API.
       * This uses the shopper's cart cookies automatically.
       * @param {number} variantId
       * @param {number} quantity
       */
      _addVariantToOnlineStoreCart: async function(variantId, quantity = 1) {
        const response = await fetch('/cart/add.js', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json',
          },
          body: JSON.stringify({
            items: [{ id: variantId, quantity }]
          }),
          credentials: 'same-origin',
        });

        if (!response.ok) {
          let details = '';
          try { details = await response.text(); } catch { /* ignore */ }
          throw new Error(`Cart add failed: ${response.status}${details ? ` ${details}` : ''}`);
        }

        return await response.json();
      },

      /**
       * Fetch the current Online Store cart JSON.
       * @returns {Promise<Object>}
       */
      _fetchOnlineStoreCart: async function() {
        const response = await fetch('/cart.js', {
          method: 'GET',
          headers: { 'Accept': 'application/json' },
          credentials: 'same-origin',
        });

        if (!response.ok) throw new Error(`Cart fetch failed: ${response.status}`);
        return await response.json();
      },

      /**
       * Best-effort update of common cart count bubbles across themes.
       * This won't cover every custom theme, but works for common patterns (ex: Dawn).
       * @param {number} itemCount
       */
      _updateCartCountUI: function(itemCount) {
        const count = (typeof itemCount === 'number' && Number.isFinite(itemCount)) ? itemCount : 0;

        const countSelectors = [
          '[data-cart-count]',
          '#cart-icon-bubble [data-cart-count]',
          '#cart-icon-bubble .cart-count-bubble span',
          '.cart-count-bubble span',
          'a[href="/cart"] .cart-count-bubble span',
        ];

        const nodes = new Set();
        countSelectors.forEach((selector) => {
          document.querySelectorAll(selector).forEach((el) => nodes.add(el));
        });

        nodes.forEach((el) => {
          // Some themes store the number in attributes; keep it simple and update text.
          if (el && typeof el.textContent === 'string') {
            el.textContent = String(count);
          }

          // If this element is inside a bubble, toggle visibility when empty.
          const bubble = el?.closest?.('.cart-count-bubble');
          if (bubble) {
            if (count > 0) {
              bubble.removeAttribute('hidden');
              bubble.style.display = '';
            } else {
              bubble.setAttribute('hidden', 'hidden');
            }
          }
        });
      },

      /**
       * Emit an event so themes can hook into cart changes (drawer refresh, etc.).
       * @param {Object} cart
       */
      _emitCartUpdatedEvent: function(cart) {
        try {
          document.dispatchEvent(new CustomEvent('shop-ai:cart-updated', { detail: cart }));
        } catch {
          // ignore
        }
      },

      /**
       * Create a product card element
       * @param {Object} product - Product data
       * @returns {HTMLElement} Product card element
       */
      createCard: function(product) {
        const card = document.createElement('div');
        card.classList.add('shop-ai-product-card');

        // Create image container
        const imageContainer = document.createElement('div');
        imageContainer.classList.add('shop-ai-product-image');

        // Add product image or placeholder
        const image = document.createElement('img');
        image.src = product.image_url || 'https://cdn.shopify.com/s/files/1/0533/2089/files/placeholder-images-image_large.png';
        image.alt = product.title;
        image.onerror = function() {
          // If image fails to load, use a fallback placeholder
          this.src = 'https://cdn.shopify.com/s/files/1/0533/2089/files/placeholder-images-image_large.png';
        };
        imageContainer.appendChild(image);
        card.appendChild(imageContainer);

        // Add product info
        const info = document.createElement('div');
        info.classList.add('shop-ai-product-info');

        // Add product title
        const title = document.createElement('h3');
        title.classList.add('shop-ai-product-title');
        title.textContent = product.title;

        // If product has a URL, make the title a link
        if (product.url) {
          const titleLink = document.createElement('a');
          titleLink.href = product.url;
          titleLink.target = '_blank';
          titleLink.textContent = product.title;
          title.textContent = '';
          title.appendChild(titleLink);
        }

        info.appendChild(title);

        // Add product price
        const price = document.createElement('p');
        price.classList.add('shop-ai-product-price');
        price.textContent = product.price;
        info.appendChild(price);

        // Add add-to-cart button
        const button = document.createElement('button');
        button.classList.add('shop-ai-add-to-cart');
        button.textContent = t('addToCart', 'Add to Cart');
        button.dataset.productId = product.id;
        if (product.variant_id) {
          button.dataset.variantId = product.variant_id;
        }

        // Add click handler for the button
        button.addEventListener('click', function() {
          // Prefer Online Store cart (Ajax API) so /cart reflects changes
          const numericVariantId = ShopAIChat.Product._toNumericVariantId(product.variant_id);
          const messagesContainer = ShopAIChat.UI?.elements?.messagesContainer;

          if (!numericVariantId) {
            // Fallback: keep previous behavior if we can't determine a variant id
            const input = document.querySelector('.shop-ai-chat-input input');
            if (input) {
              const promptTemplate = t('addToCartPrompt', 'Add {{title}} to my cart');
              input.value = template(promptTemplate, { title: product.title });
              const sendButton = document.querySelector('.shop-ai-chat-send');
              if (sendButton) sendButton.click();
            }
            return;
          }

          const previousText = button.textContent;
          button.disabled = true;
          button.textContent = t('addingToCart', 'Adding…');

          ShopAIChat.Product._addVariantToOnlineStoreCart(numericVariantId, 1)
            .then(() => {
              button.textContent = t('addedToCart', 'Added');
              if (messagesContainer) {
                const msgTemplate = t(
                  'addedToCartMessage',
                  'Added **{{title}}** to your cart. You can [click here to view your cart](/cart).'
                );
                ShopAIChat.Message.add(
                  template(msgTemplate, { title: product.title }),
                  'assistant',
                  messagesContainer
                );
              }

              // Best-effort: refresh cart count bubble and emit an event for themes to hook into.
              ShopAIChat.Product._fetchOnlineStoreCart()
                .then((cart) => {
                  ShopAIChat.Product._updateCartCountUI(cart?.item_count);
                  ShopAIChat.Product._emitCartUpdatedEvent(cart);
                })
                .catch((error) => {
                  debugWarn('Unable to refresh cart UI after add:', error);
                });

              // Reset button label after a short delay
              setTimeout(() => {
                button.disabled = false;
                button.textContent = previousText;
              }, 1500);
            })
            .catch((error) => {
              debugError('Error adding to Online Store cart:', error);
              button.disabled = false;
              button.textContent = previousText;
              if (messagesContainer) {
                ShopAIChat.Message.add(
                  t('addToCartFailed', "Sorry, I couldn't add that to your cart. Please try again."),
                  'assistant',
                  messagesContainer
                );
              }
            });
        });

        info.appendChild(button);
        card.appendChild(info);

        return card;
      }
    },

    /**
     * Online Store cart helpers (Ajax Cart API)
     */
    Cart: {
      /**
       * Very small intent detector for "show my cart" style questions.
       * @param {string} message
       * @returns {boolean}
       */
      isCartQuery: function(message) {
        if (typeof message !== 'string') return false;
        const m = message.trim().toLowerCase();
        if (!m) return false;

        // English + French common phrases
        if (m === 'cart' || m === 'my cart' || m === 'panier' || m === 'mon panier') return true;
        if (m.includes('what is in my cart') || m.includes("what's in my cart") || m.includes('show my cart')) return true;
        if (m.includes('what is in my basket') || m.includes("what's in my basket") || m.includes('show my basket')) return true;
        if (m.includes('what is in my panier') || m.includes('voir mon panier') || m.includes('contenu de mon panier')) return true;

        // Looser match: mentions cart/panier + "what/see/show"
        const hasCartWord = /\b(cart|basket|panier)\b/i.test(m);
        const hasQueryVerb = /\b(what|show|see|list|display|voir|affiche|afficher|montre|montrer|liste)\b/i.test(m);
        return hasCartWord && hasQueryVerb;
      },

      /**
       * Format cents into a readable amount (best-effort).
       * @param {number} cents
       * @param {string|undefined} currency
       * @returns {string}
       */
      formatMoney: function(cents, currency) {
        if (typeof cents !== 'number' || !Number.isFinite(cents)) return '';
        const amount = (cents / 100);
        const curr = (typeof currency === 'string' && currency) ? currency : '';
        return curr ? `${curr} ${amount.toFixed(2)}` : amount.toFixed(2);
      },

      /**
       * Render a cart summary message (markdown-friendly).
       * @param {Object} cart
       * @returns {string}
       */
      renderSummary: function(cart) {
        const itemCount = (typeof cart?.item_count === 'number') ? cart.item_count : 0;
        const currency = cart?.currency;
        const totalPrice = (typeof cart?.total_price === 'number') ? cart.total_price : 0;

        if (!cart || itemCount <= 0) {
          const empty = t('cartEmpty', 'Your cart is currently empty.');
          return `${empty}\n\n[${t('viewCartLinkText', 'View your cart')}](/cart)`;
        }

        const header = t('cartSummaryHeader', "Here's what's currently in your cart:");
        const lines = Array.isArray(cart.items) ? cart.items : [];

        const renderedLines = lines.map((item) => {
          const title = item?.product_title || item?.title || 'Item';
          const variantTitle = item?.variant_title && item.variant_title !== 'Default Title' ? ` (${item.variant_title})` : '';
          const qty = item?.quantity || 1;
          return `- ${title}${variantTitle} × ${qty}`;
        }).join('\n');

        const subtotalLabel = t('cartSubtotalLabel', 'Subtotal');
        const subtotal = this.formatMoney(totalPrice, currency);
        const itemsLabel = t('cartItemsCountLabel', 'Items');

        return `${header}\n${renderedLines}\n\n${itemsLabel}: ${itemCount}\n${subtotalLabel}: ${subtotal}\n\n[${t('viewCartLinkText', 'View your cart')}](/cart)`;
      },

      /**
       * Handle a cart query locally (no MCP / no LLM).
       * @param {HTMLElement} messagesContainer
       */
      handleCartQuery: async function(messagesContainer) {
        try {
          debugLog('Fetching Online Store cart', { url: '/cart.js' });
          const cart = await ShopAIChat.Product._fetchOnlineStoreCart();
          debugLog('Fetched Online Store cart', { item_count: cart?.item_count, currency: cart?.currency });
          ShopAIChat.UI.removeTypingIndicator();
          ShopAIChat.Message.add(this.renderSummary(cart), 'assistant', messagesContainer);
        } catch (error) {
          debugError('Error fetching Online Store cart:', error);
          ShopAIChat.UI.removeTypingIndicator();
          ShopAIChat.Message.add(
            t('cartFetchFailed', "Sorry, I couldn't load your cart right now. Please try again."),
            'assistant',
            messagesContainer
          );
        }
      }
    },

    /**
     * Initialize the chat application
     */
    init: function() {
      // Initialize UI
      const container = document.querySelector('.shop-ai-chat-container');
      if (!container) return;

      this.UI.init(container);

      // Restore last product results (best-effort) so ordinal selections work after reload.
      try {
        const persisted = sessionStorage.getItem('shopAiLastProductResults');
        if (persisted) {
          const parsed = JSON.parse(persisted);
          if (Array.isArray(parsed)) {
            this.state.lastProductResults = parsed;
            debugLog('Restored lastProductResults from sessionStorage', { count: parsed.length });
          }
        }
      } catch (e) {
        debugWarn('Unable to restore lastProductResults from sessionStorage', e);
      }

      // Check for existing conversation
      const conversationId = sessionStorage.getItem('shopAiConversationId');

      if (conversationId) {
        // Fetch conversation history
        this.API.fetchChatHistory(conversationId, this.UI.elements.messagesContainer);
      } else {
        // No previous conversation, show welcome message
        const welcomeMessage = window.shopChatConfig?.welcomeMessage || t('welcomeDefault', "👋 Hi there! How can I help you today?");
        this.Message.add(welcomeMessage, 'assistant', this.UI.elements.messagesContainer);
      }
    }
  };

  // Initialize the application when DOM is ready
  document.addEventListener('DOMContentLoaded', function() {
    ShopAIChat.init();
  });
})();
