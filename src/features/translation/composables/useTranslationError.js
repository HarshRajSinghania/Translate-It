// useTranslationError.js
// Centralized translation error management composable

import { ref, computed, onUnmounted } from 'vue'
import { useErrorHandler } from '@/composables/shared/useErrorHandler.js'
import { ErrorHandler } from '@/shared/error-management/ErrorHandler.js'
import ExtensionContextManager from '@/core/extensionContext.js'
import { ErrorTypes } from '@/shared/error-management/ErrorTypes.js'
import { getErrorDisplayStrategy, processErrorMessage, shouldShowRetry, shouldShowSettings } from '@/shared/error-management/ErrorDisplayStrategies.js'
import { isCancellationError, matchErrorToType } from '@/shared/error-management/ErrorMatcher.js'
import { mapCanonicalTranslationError } from '@/shared/error-management/PublicTranslationErrorPolicy.js'
import { PublicTranslationErrorActions } from '@/shared/error-management/PublicTranslationError.js'
import { createLegacyDisplayError } from '@/shared/error-management/PublicTranslationErrorAdapter.js'
import { getScopedLogger } from '@/shared/logging/logger.js'
import { LOG_COMPONENTS } from '@/shared/logging/logConstants.js'
import { openOptionsPage } from '@/core/helpers.js'

// Lazy logger to avoid TDZ ReferenceErrors when bundled
const logger = new Proxy({}, {
  get(target, prop) {
    const instance = getScopedLogger(LOG_COMPONENTS.UI, 'useTranslationError');
    const value = instance[prop];
    return typeof value === 'function' ? value.bind(instance) : value;
  }
});

/**
 * useTranslationError - Composable for localized translation error handling
 * 
 * @param {string} context - Translation context ('popup', 'sidepanel', 'content', 'selection')
 * @returns {Object} Error management interface
 */
export function useTranslationError(context = 'unknown') {
  // Error state
  const currentError = ref(null)
  const errorMessage = ref('')
  const errorType = ref('')
  const canRetry = ref(false)
  const canOpenSettings = ref(false)
  const errorTimestamp = ref(null)
  
  // Error handling
  const { handleTranslationError, getErrorForDisplay, isRetryableError } = useErrorHandler()
  const errorHandler = ErrorHandler.getInstance()
  
  // UI error listener for real-time error updates
  let unsubscribeListener = null
  
  // Computed properties
  const hasError = computed(() => Boolean(currentError.value && errorMessage.value))
  const errorDisplayLevel = computed(() => {
    if (!errorType.value) return 'detailed'
    const strategy = getErrorDisplayStrategy(context, errorType.value)
    return strategy.errorLevel
  })
  
  const processedErrorMessage = computed(() => {
    if (!errorMessage.value) return ''
    return processErrorMessage(errorMessage.value, errorDisplayLevel.value, context)
  })
  
  /**
   * Handle a translation error
   * @param {Error|string} error - The error to handle
   * @param {Object} options - Additional options
   */
  const handleError = async (error, options = {}) => {
    if (!error) {
      clearError()
      return
    }

    // Identify and ignore user cancellation errors
    const errorTypeValue = matchErrorToType(error)
    if (isCancellationError(error)) {
      logger.debug(`[${context}] Silently ignoring user cancellation error`);
      return;
    }
    
    try {
      logger.debug(`[${context}] Handling translation error:`, error)
      
      const isContextError = ExtensionContextManager.isContextError(error)
      const isLocalValidationError = [ErrorTypes.TEXT_EMPTY, ErrorTypes.TEXT_TOO_LONG].includes(errorTypeValue)
      const usePublicBoundary = !isContextError && !isLocalValidationError
      let displayError = error
      let errorInfo
      let publicError = null

      if (usePublicBoundary) {
        publicError = mapCanonicalTranslationError(error)
        displayError = await createLegacyDisplayError(error, publicError)
        if (!displayError) return

        errorInfo = {
          message: displayError.message,
          timestamp: Date.now()
        }
      } else {
        // Preserve context and local input-validation behavior outside the
        // ordinary translation public boundary.
        errorInfo = await getErrorForDisplay(error, context)
      }

      const strategy = getErrorDisplayStrategy(context, errorTypeValue)
      
      // Update error state
      currentError.value = error
      errorMessage.value = errorInfo.message
      errorType.value = errorTypeValue
      errorTimestamp.value = errorInfo.timestamp
      canRetry.value = publicError
        ? publicError.action === PublicTranslationErrorActions.RETRY
        : shouldShowRetry(errorTypeValue, strategy)
      canOpenSettings.value = publicError
        ? publicError.action === PublicTranslationErrorActions.OPEN_SETTINGS
        : shouldShowSettings(errorTypeValue, strategy)
      
      // Handle error with appropriate strategy
      const enhancedOptions = {
        showToast: strategy.showToast,
        showInUI: strategy.showInUI,
        errorLevel: strategy.errorLevel,
        component: 'translation',
        ...options
      }
      
      await handleTranslationError(displayError, context, {
        ...enhancedOptions,
        ...(usePublicBoundary && { type: errorTypeValue })
      })
      
      logger.debug(`[${context}] Error handled with strategy:`, strategy)
      
    } catch (handlerError) {
      logger.error(`[${context}] Failed to handle translation error:`, handlerError)
      
      // Fallback error state
      currentError.value = error
      errorMessage.value = 'An error occurred during translation'
      errorType.value = 'UNKNOWN'
      errorTimestamp.value = Date.now()
      canRetry.value = true
      canOpenSettings.value = false
    }
  }
  
  /**
   * Clear current error state
   */
  const clearError = () => {
    currentError.value = null
    errorMessage.value = ''
    errorType.value = ''
    canRetry.value = false
    canOpenSettings.value = false
    errorTimestamp.value = null
  }
  
  /**
   * Get retry callback for current error
   * @param {Function} retryFn - Function to retry the operation
   * @returns {Function} Retry callback
   */
  const getRetryCallback = (retryFn) => {
    return async () => {
      if (!canRetry.value) {
        logger.warn(`[${context}] Retry attempted but not available`)
        return
      }
      
      try {
        logger.info(`[${context}] Retrying translation after error: ${errorType.value}`)
        clearError()
        if (typeof retryFn === 'function') {
          await retryFn()
        }
      } catch (retryError) {
        logger.error(`[${context}] Retry failed:`, retryError)
        await handleError(retryError)
      }
    }
  }
  
  /**
   * Get settings callback for current error
   * @returns {Function} Settings callback
   */
  const getSettingsCallback = () => {
    return () => {
      if (!canOpenSettings.value) {
        logger.warn(`[${context}] Settings attempted but not available`)
        return
      }
      
      try {
        logger.info(`[${context}] Opening settings for error: ${errorType.value}`)
        // Open the extension options page via the established helper
        openOptionsPage()
      } catch (settingsError) {
        logger.error(`[${context}] Failed to open settings:`, settingsError)
      }
    }
  }
  
  /**
   * Setup UI error listener for real-time error updates
   */
  const setupErrorListener = () => {
    if (unsubscribeListener) return // Already setup
    
    const listener = (errorData) => {
      if (errorData.context && errorData.context.includes(context)) {
        logger.debug(`[${context}] Received UI error update:`, errorData)
        currentError.value = errorData
        errorMessage.value = errorData.message
        errorType.value = errorData.type
        errorTimestamp.value = errorData.timestamp
        canRetry.value = errorData.canRetry || false
        canOpenSettings.value = errorData.canOpenSettings || false
      }
    }
    
    unsubscribeListener = errorHandler.addUIErrorListener(listener)
  }
  
  /**
   * Cleanup error listener
   */
  const cleanup = () => {
    if (unsubscribeListener) {
      unsubscribeListener()
      unsubscribeListener = null
    }
  }
  
  // Setup listener on composable creation
  setupErrorListener()
  
  // Cleanup on unmount
  onUnmounted(cleanup)
  
  return {
    // State
    hasError,
    errorMessage: processedErrorMessage,
    errorType,
    canRetry,
    canOpenSettings,
    errorTimestamp,
    errorDisplayLevel,
    
    // Methods
    handleError,
    clearError,
    getRetryCallback,
    getSettingsCallback,
    isRetryableError
  }
}
