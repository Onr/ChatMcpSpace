/**
 * Page Transition Handler
 * Manages smooth transitions between dashboard and settings pages
 * Includes smooth nav bar morphing with dual-text technique
 */

(function () {
  const TRANSITION_DURATION = 400; // ms
  const BLUR_TRANSITION = false; // Set to true for blur effect on exit
  const MORPH_DURATION = 300; // ms for button text morphing

  /**
   * Initialize page transition handlers
   */
  function initPageTransitions() {
    const navToggleButton = document.getElementById('navToggleButton');

    if (navToggleButton) {
      navToggleButton.setAttribute('data-transition', 'true');
      navToggleButton.addEventListener('click', handleNavigationClick);

      // Initialize with correct next-text based on current page
      updateNavButtonState(navToggleButton);
    }

    // Handle all internal navigation links that should have transitions
    document.querySelectorAll('a[data-transition]').forEach((link) => {
      link.addEventListener('click', handleNavigationClick);
    });

    // Make settings/dashboard buttons transition-aware
    document.querySelectorAll('a[href="/settings"], a[href="/dashboard"]').forEach((link) => {
      if (link !== navToggleButton && !link.hasAttribute('data-transition')) {
        link.setAttribute('data-transition', 'true');
        link.addEventListener('click', handleNavigationClick);
      }
    });
  }

  /**
   * Update nav button state based on current page
   */
  function updateNavButtonState(button) {
    const path = window.location.pathname;
    const isSettings = path === '/settings' || path.startsWith('/settings/');

    button.href = isSettings ? '/dashboard' : '/settings';

    // Update button texts
    const currentText = button.querySelector('.button-text');
    const nextText = button.querySelector('.button-text-next');

    if (currentText) {
      currentText.textContent = isSettings ? 'Dashboard' : 'Settings';
    }

    if (nextText) {
      nextText.textContent = isSettings ? 'Settings' : 'Dashboard';
    }

    button.setAttribute('data-next-text', isSettings ? 'Settings' : 'Dashboard');
  }

  /**
   * Handle navigation link clicks with transition effect
   */
  function handleNavigationClick(e) {
    const link = e.currentTarget;
    const href = link.getAttribute('href');

    // Skip if it's an external link or has target="_blank"
    if (link.target === '_blank' || !href || href.startsWith('http') || href.startsWith('//')) {
      return;
    }

    // Only proceed for dashboard/settings transitions
    if (!href.includes('/dashboard') && !href.includes('/settings')) {
      return;
    }

    e.preventDefault();

    // If this is the nav toggle button, morph it first
    if (link.id === 'navToggleButton') {
      morphNavButton(link);
    }

    // Trigger page exit animation
    triggerPageExit(() => {
      // Navigate after animation completes
      window.location.href = href;
    });
  }

  /**
   * Morph the nav toggle button text smoothly with dual-text technique
   */
  function morphNavButton(button) {
    // Add morphing class to trigger CSS transitions
    button.classList.add('morphing');

    // After the transition completes, update internal state
    setTimeout(() => {
      // Swap the texts
      const currentText = button.querySelector('.button-text');
      const nextText = button.querySelector('.button-text-next');

      if (currentText && nextText) {
        // Store current next text
        const temp = nextText.textContent;

        // Move next text to current
        currentText.textContent = nextText.textContent;

        // Get new next text based on where we're going
        const href = button.getAttribute('href');
        const newNextText = href.includes('/settings') ? 'Settings' : 'Dashboard';
        nextText.textContent = newNextText;

        // Update button's href for next click
        button.href = href.includes('/settings') ? '/dashboard' : '/settings';
        button.setAttribute('data-next-text', newNextText);
      }

      // Remove morphing class to reset for next transition
      button.classList.remove('morphing');
    }, MORPH_DURATION);
  }

  /**
   * Trigger the page exit animation
   */
  function triggerPageExit(callback) {
    const main = document.querySelector('main');

    if (!main) {
      callback();
      return;
    }

    // Choose animation type
    if (BLUR_TRANSITION) {
      main.classList.add('page-exiting-blur');
    } else {
      main.classList.add('page-exiting');
    }

    // Keep nav visible and smooth during transition
    const nav = document.querySelector('nav');
    if (nav) {
      nav.style.opacity = '1';
    }

    // Execute callback after animation completes
    setTimeout(callback, TRANSITION_DURATION);
  }

  /**
   * Ensure page animation plays on initial load
   */
  function ensurePageEnter() {
    const main = document.querySelector('main');
    if (main) {
      // Trigger reflow to ensure animation plays
      void main.offsetHeight;
    }
  }

  /**
   * Handle browser back/forward button
   */
  window.addEventListener('pageshow', (e) => {
    if (e.persisted) {
      // Page was restored from cache
      const main = document.querySelector('main');
      if (main) {
        main.classList.remove('page-exiting', 'page-exiting-blur');
      }

      const nav = document.querySelector('nav');
      if (nav) {
        nav.style.opacity = '1';
      }

      // Reset nav button to current state
      const navToggleButton = document.getElementById('navToggleButton');
      if (navToggleButton) {
        navToggleButton.classList.remove('morphing');
        updateNavButtonState(navToggleButton);
      }

      ensurePageEnter();
    }
  });

  // Initialize when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initPageTransitions);
  } else {
    initPageTransitions();
  }

  // Also initialize page enter animation
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', ensurePageEnter);
  } else {
    ensurePageEnter();
  }
})();
