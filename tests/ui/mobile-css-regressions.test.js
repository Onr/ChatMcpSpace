const fs = require('fs');
const path = require('path');

describe('Mobile layout regression guards', () => {
  const cssPath = path.join(__dirname, '../../public/css/style.css');
  const jsPath = path.join(__dirname, '../../public/js/dashboard.js');
  const layoutPath = path.join(__dirname, '../../views/layout.ejs');
  const dashboardPath = path.join(__dirname, '../../views/dashboard.ejs');
  const multiChatPath = path.join(__dirname, '../../public/js/multi-chat.js');
  const css = fs.readFileSync(cssPath, 'utf8');
  const js = fs.readFileSync(jsPath, 'utf8');
  const layout = fs.readFileSync(layoutPath, 'utf8');
  const dashboard = fs.readFileSync(dashboardPath, 'utf8');
  const multiChat = fs.readFileSync(multiChatPath, 'utf8');

  it('viewport meta opts into interactive-widget=resizes-content so keyboard shrinks layout viewport on Chrome/Android', () => {
    expect(layout).toMatch(/<meta name="viewport"[^>]*interactive-widget=resizes-content/);
  });

  it('cache-busts the dashboard stylesheet so mobile fixes are not held by the 24-hour static cache', () => {
    expect(layout).toMatch(/<link rel="stylesheet" href="\/css\/style\.css\?v=<%= Date\.now\(\) %>">/);
  });

  it('keeps mobile chrome visible even if legacy collapse classes are present', () => {
    expect(css).toMatch(/body\.mobile-chrome-collapsed nav/);
    expect(css).toMatch(/body\.mobile-chrome-collapsed \.council-chamber/);
    expect(css).toMatch(/body\.mobile-chrome-collapsed nav[\s\S]*?transform:\s*none\s*!important;/);
    expect(js).toMatch(/function setMobileChromeCollapsed\(\)\s*\{[\s\S]*?classList\.remove\('mobile-chrome-collapsed'\)/);
  });

  it('keeps input anchored at bottom and interactive section visible in mobile layout', () => {
    // Input is absolutely anchored inside the viewport-constrained chat tile. Using
    // position:fixed here regresses on mobile Chromium when glass/animation layers
    // create transformed containing blocks.
    expect(css).toMatch(/#messageInputArea\s*\{[\s\S]*?position:\s*absolute\s*!important;/);
    expect(css).toMatch(/--mobile-composer-bottom-gap:\s*max\(2\.25rem,\s*calc\(env\(safe-area-inset-bottom,\s*0px\)\s*\+\s*1\.25rem\)\)/);
    expect(css).toMatch(/--mobile-composer-scroll-buffer:\s*0\.25rem;/);
    expect(css).toMatch(/#messageInputArea\s*\{[\s\S]*?bottom:\s*0\s*!important;/);
    expect(css).toMatch(/#messageInputArea\s*\{[\s\S]*?padding-bottom:\s*var\(--mobile-composer-bottom-gap\)\s*!important;/);
    // Interactive space stays visible
    expect(css).toMatch(/#mainInteractiveSpace\s*\{[\s\S]*?flex:\s*0 0 auto\s*!important;/);
  });

  it('keeps mobile send, stop, model, and attachment controls inside the input tray', () => {
    expect(css).toMatch(/#messageInputArea #userMessageForm\s*\{[\s\S]*?display:\s*grid\s*!important;/);
    expect(css).toMatch(/#messageInputArea #userMessageForm\s*\{[\s\S]*?min-width:\s*0;/);
    expect(css).toMatch(/#messageInputArea #userMessageForm>\*\s*\{[\s\S]*?margin-top:\s*0\s*!important;[\s\S]*?margin-bottom:\s*0\s*!important;/);
    expect(css).toMatch(/#messageInputArea #userMessageForm>\.relative\s*\{[\s\S]*?display:\s*contents;/);
    expect(css).toMatch(/#messageInputArea \.composer-action-row\s*\{[\s\S]*?display:\s*contents\s*!important;/);
    expect(css).toMatch(/#messageInputArea \.mobile-agent-status-strip\s*\{[\s\S]*?position:\s*relative;/);
    expect(css).toMatch(/#messageInputArea \.mobile-agent-status-strip\s*\{[\s\S]*?width:\s*100%;/);
    expect(css).not.toMatch(/#messageInputArea \.mobile-agent-status-strip\s*\{[\s\S]*?bottom:\s*calc\(100%/);
    expect(css).toMatch(/#messageInputArea #agentStopBtn,\s*\n\s*#messageInputArea #userMessageSend\s*\{[\s\S]*?display:\s*flex\s*!important;[\s\S]*?align-items:\s*center;/);
    expect(css).toMatch(/#messageInputArea #agentStopBtn,\s*\n\s*#messageInputArea #userMessageSend\s*\{[\s\S]*?margin-bottom:\s*0\.56rem;/);
    expect(css).toMatch(/#messageInputArea #generalFileUploadLabel,\s*\n\s*#messageInputArea #imageUploadLabel\s*\{[\s\S]*?display:\s*flex\s*!important;[\s\S]*?justify-content:\s*center;/);
    expect(dashboard).toMatch(/class="send-spaceship-icon"/);
    expect(dashboard).toMatch(/class="send-spaceship-flame"/);
    expect(css).toMatch(/#messageInputArea #userMessageSend\s*\{[\s\S]*?grid-column:\s*5;[\s\S]*?margin-right:\s*0\.45rem;[\s\S]*?justify-self:\s*end;/);
    expect(css).not.toContain('scheduledMessagesBtn');
    expect(css).toMatch(/#messageInputArea #userMessageSend \.send-label\s*\{[\s\S]*?display:\s*none;/);
    expect(css).toMatch(/#messageInputArea #userMessageSend \.send-spaceship-icon\s*\{[\s\S]*?width:\s*1\.08rem;/);
    expect(css).not.toMatch(/#messageInputArea #userMessageSend::before\s*\{[\s\S]*?content:\s*'✈'/);
    expect(css).toMatch(/#messageInputArea #agentConfigDropdown\s*\{[\s\S]*?bottom:\s*calc\(var\(--mobile-composer-height/);
  });

  it('allows the mobile photo picker to select and render videos as encrypted attachments', () => {
    expect(dashboard).toContain('accept="image/*,video/*"');
    expect(dashboard).toContain('title="Attach photos or videos"');
    expect(js).toMatch(/const isAllowedVideo = String\(file\.type \|\| ''\)\.startsWith\('video\/'\)/);
    expect(js).toMatch(/isAttachmentVideo\(fileOrAttachment\)/);
    expect(js).toMatch(/document\.createElement\('video'\)/);
    expect(js).toMatch(/function inferAttachmentContentType\(fileOrAttachment\)/);
    expect(js).toMatch(/application\/octet-stream/);
    expect(js).toMatch(/ATTACHMENT_EXTENSION_CONTENT_TYPES/);
    expect(js).toMatch(/source\.type = inferAttachmentContentType\(attachment\)/);
    expect(css).toMatch(/\.message-attachment-video\s*\{/);
    expect(multiChat).toContain('accept="image/*,video/*"');
    expect(multiChat).toMatch(/const isVideo = String\(file\.type \|\| ''\)\.startsWith\('video\/'\)/);
  });

  it('keeps mobile composer bottom spacing below the textbox in narrow and rotated-phone layouts', () => {
    expect(css).toMatch(/@media \(max-width:\s*767px\)[\s\S]*?#conversationArea\s*\{[\s\S]*?padding-bottom:\s*calc\(var\(--mobile-composer-height,\s*110px\)\s*\+\s*0\.25rem\)\s*!important;/);
    expect(css).toMatch(/@media \(max-width:\s*767px\)[\s\S]*?#messageInputArea\s*\{[\s\S]*?bottom:\s*0\s*!important;/);
    expect(css).toMatch(/@media \(max-width:\s*767px\)[\s\S]*?#messageInputArea\s*\{[\s\S]*?padding-bottom:\s*var\(--mobile-composer-bottom-gap\)\s*!important;/);
    expect(css).toMatch(/@media \(pointer:\s*coarse\) and \(orientation:\s*landscape\) and \(max-height:\s*600px\)[\s\S]*?#conversationArea\s*\{[\s\S]*?padding-bottom:\s*calc\(var\(--mobile-composer-height,\s*86px\)\s*\+\s*0\.25rem\)\s*!important;/);
    expect(css).toMatch(/@media \(pointer:\s*coarse\) and \(orientation:\s*landscape\) and \(max-height:\s*600px\)[\s\S]*?#messageInputArea\s*\{[\s\S]*?bottom:\s*0\s*!important;/);
    expect(css).toMatch(/@media \(pointer:\s*coarse\) and \(orientation:\s*landscape\) and \(max-height:\s*600px\)[\s\S]*?#messageInputArea\s*\{[\s\S]*?padding-bottom:\s*var\(--mobile-composer-bottom-gap,\s*2\.25rem\)\s*!important;/);
    expect(css).not.toMatch(/^\s*bottom:\s*var\(--mobile-composer-bottom-gap/m);
  });

  it('keeps the mobile scroll-to-bottom control visible above the composer', () => {
    expect(dashboard).toMatch(/id="scrollToBottomBtn"/);
    expect(css).toMatch(/#scrollToBottomBtn:not\(\.hidden\)\s*\{[\s\S]*?display:\s*flex;/);
    expect(css).toMatch(/@media \(max-width:\s*767px\)[\s\S]*?#scrollToBottomBtn\s*\{[\s\S]*?bottom:\s*calc\(var\(--mobile-composer-height,\s*110px\)\s*\+\s*0\.85rem\)\s*!important;/);
    expect(css).toMatch(/@media \(max-width:\s*767px\)[\s\S]*?#scrollToBottomBtn\s*\{[\s\S]*?z-index:\s*130\s*!important;/);
    expect(css).toMatch(/@media \(pointer:\s*coarse\) and \(orientation:\s*landscape\) and \(max-height:\s*600px\)[\s\S]*?#scrollToBottomBtn\s*\{[\s\S]*?bottom:\s*calc\(var\(--mobile-composer-height,\s*86px\)\s*\+\s*0\.55rem\)\s*!important;/);
    expect(js).toMatch(/window\.updateScrollToBottomButton = updateScrollBtn/);
    expect(js).toMatch(/const shouldShow = selectedAgentId && selectedAgentId !== '__ALL__'[\s\S]*?distFromBottom > 120/);
    expect(js).toMatch(/const focusComposerFromScrollControl = \(\) => \{[\s\S]*?focusMobileComposerFromBottomOverscroll\(convArea,\s*\{[\s\S]*?requireBottomEdge:\s*false,[\s\S]*?respectCooldown:\s*false[\s\S]*?\}\);[\s\S]*?\};/);
    expect(js).toMatch(/btn\.addEventListener\('pointerdown',\s*focusComposerFromScrollControl,\s*\{ passive:\s*true \}\)/);
    expect(js).toMatch(/btn\.addEventListener\('touchend',\s*focusComposerFromScrollControl,\s*\{ passive:\s*true \}\)/);
    expect(js).toMatch(/btn\.addEventListener\('click',\s*\(\) => \{[\s\S]*?forceScrollToBottomOnNextRender = true;[\s\S]*?forceScrollToBottomUntil = Date\.now\(\) \+ 2500;[\s\S]*?focusComposerFromScrollControl\(\);[\s\S]*?scrollToBottom\(\{ smooth:\s*false,\s*force:\s*true,\s*source:\s*'scroll-button' \}\)/);
    expect(js).toMatch(/function scrollToBottom\(options = \{\}\)[\s\S]*?const \{ smooth = false,\s*force = true \} = options/);
    expect(js).toMatch(/const getBottomScrollTop = \(\) => Math\.max\([\s\S]*?conversationArea\.scrollHeight - conversationArea\.clientHeight/);
    expect(js).toMatch(/const latestMessage = renderedMessages\[renderedMessages\.length - 1\]/);
    expect(js).toMatch(/setTimeout\(settleAtBottom,\s*300\)/);
    expect(js).toMatch(/setTimeout\(settleAtBottom,\s*1200\)/);
  });

  it('focuses the mobile composer only after an intentional extra pull at the bottom', () => {
    expect(js).toMatch(/function focusMobileComposerFromBottomOverscroll\(conversationArea,\s*options = \{\}\)/);
    expect(js).toMatch(/focusMobileComposerFromBottomOverscroll\.cooldownUntil/);
    expect(js).toMatch(/requireBottomEdge = true/);
    expect(js).toMatch(/respectCooldown = true/);
    expect(js).toMatch(/syncMobileComposerLayout\(\);/);
    expect(js).toMatch(/input\.setSelectionRange\(end,\s*end\)/);
    expect(js).toMatch(/input\.focus\(\{ preventScroll:\s*true \}\)/);
    expect(js).toMatch(/input\.click\(\)/);
    expect(js).toMatch(/setTimeout\(\(\) => \{[\s\S]*?if \(document\.activeElement !== input\) \{[\s\S]*?focusInput\(\);[\s\S]*?\}[\s\S]*?\},\s*60\)/);
    expect(js).toMatch(/let bottomFocusEligible = false/);
    expect(js).toMatch(/bottomFocusEligible = \(convArea\.scrollHeight - convArea\.clientHeight - convArea\.scrollTop\) <= 32/);
    expect(js).toMatch(/if \(bottomFocusEligible && bottomRevealTriggered && upwardDragDistance > 28\)/);
    expect(js).toMatch(/if \(bottomFocusRequested\) \{[\s\S]*?event\.preventDefault\(\);[\s\S]*?focusMobileComposerFromBottomOverscroll\(convArea,\s*\{[\s\S]*?requireBottomEdge:\s*false,[\s\S]*?respectCooldown:\s*false[\s\S]*?\}\);/);
    expect(js).toMatch(/convArea\.addEventListener\('touchend',[\s\S]*?\{ passive:\s*false \}\)/);
  });

  it('forces a newly opened chat to settle on the latest message', () => {
    expect(js).toMatch(/let forceScrollToBottomOnNextRender = false/);
    expect(js).toMatch(/forceScrollToBottomOnNextRender = true/);
    expect(js).toMatch(/let forceScrollToBottomUntil = 0/);
    expect(js).toMatch(/forceScrollToBottomUntil = Date\.now\(\) \+ 2500/);
    expect(js).toMatch(/const shouldForceBottom = !append && \(forceScrollToBottomOnNextRender \|\| Date\.now\(\) < forceScrollToBottomUntil\)/);
    expect(js).toMatch(/const settleAtBottom = \(\) => \{[\s\S]*?conversationArea\.scrollTop = bottomScrollTop/);
    expect(js).toMatch(/requestAnimationFrame\(\(\) => \{[\s\S]*?settleAtBottom\(\);/);
  });

  it('does not jump the conversation while appending or background-loading messages away from the bottom', () => {
    expect(js).toMatch(/const wasNearBottomBeforeRender = previousDistanceFromBottom < 120/);
    expect(js).toMatch(/else if \(append && !wasNearBottomBeforeRender\) \{\s*conversationArea\.scrollTop = previousScrollTop;\s*\}/);
    expect(js).toMatch(/preserveScrollPosition:\s*!wasNearBottom && !shouldStayPinnedToLatest/);
    expect(js).toMatch(/conversationArea\.scrollHeight - conversationArea\.clientHeight - previousDistanceFromBottom/);
  });

  it('keeps pressing send from moving the active chat upward', () => {
    expect(js).toMatch(/function captureSendScrollGuard\(\)/);
    expect(js).toMatch(/function settleScrollAfterSend\(guard\)/);
    expect(js).toMatch(/const sendScrollGuard = captureSendScrollGuard\(\)/);
    expect(js).toMatch(/settleScrollAfterSend\(sendScrollGuard\)/);
    expect(js).toMatch(/if \(sendScrollGuard\?\.wasNearBottom\) \{[\s\S]*?forceScrollToBottomOnNextRender = true;[\s\S]*?forceScrollToBottomUntil = Date\.now\(\) \+ 2500;/);
    expect(js).toMatch(/if \(guard\.wasNearBottom\) \{[\s\S]*?scrollToBottom\(\{ smooth:\s*false,\s*force:\s*true \}\);/);
    expect(js).toMatch(/if \(conversationArea\.scrollTop < guard\.scrollTop\) \{[\s\S]*?conversationArea\.scrollTop = guard\.scrollTop;/);
  });

  it('keeps the mobile visual viewport bottom offset at zero while tracking viewport height', () => {
    expect(js).toMatch(/--mobile-visual-bottom-offset/);
    expect(js).toMatch(/setProperty\('--mobile-visual-bottom-offset',\s*'0px'\)/);
  });

  it('does not translate visual-viewport delta into composer position changes', () => {
    // Chrome/Android resizes the layout viewport through the viewport meta.
    // Manually applying visualViewport deltas can hide the action buttons.
    expect(js).toMatch(/const isTextInputFocused = \(\)/);
    expect(js).toMatch(/function preserveMobileConversationScroll\(\)/);
    expect(js).toMatch(/const preservedScrollTop = conversationArea\.scrollTop/);
    expect(js).toMatch(/conversationArea\.scrollTop = preservedScrollTop/);
    expect(js).toMatch(/const shouldPreserveScroll = isTextInputFocused\(\)/);
    expect(js).toMatch(/if \(shouldPreserveScroll\) \{[\s\S]*?preserveMobileConversationScroll\(\);[\s\S]*?\}/);
    expect(js).not.toMatch(/convArea\.scrollTop = convArea\.scrollHeight/);
    expect(js).not.toMatch(/conversationArea\.scrollTop = conversationArea\.scrollHeight/);
    // Re-evaluate on focus changes so the composer snaps back to bottom: 0 when keyboard closes
    expect(js).toMatch(/document\.addEventListener\('focusin',\s*adjustMobileViewport\)/);
    expect(js).toMatch(/document\.addEventListener\('focusout'/);
    // Listen to visualViewport scroll too — the visual viewport can shift without resize
    expect(js).toMatch(/window\.visualViewport\.addEventListener\('scroll',\s*adjustMobileViewport\)/);
  });

  it('recovers the mobile composer after keyboard close, page restore, and chat scrolling', () => {
    expect(js).toMatch(/const shouldShowComposer = selectedAgentId && selectedAgentId !== '__ALL__'/);
    expect(css).toMatch(/body\[data-agent-selected="true"\]:not\(\[data-all-chats-view="true"\]\) #messageInputArea,\s*\n\s*body\[data-agent-selected="true"\]:not\(\[data-all-chats-view="true"\]\) #messageInputArea\.hidden\s*\{[\s\S]*?display:\s*block\s*!important;/);
    expect(js).toMatch(/convArea\.addEventListener\('scroll',\s*\(\) => \{[\s\S]*?ensureMobileComposerVisible\(\{ restoreChrome:\s*true \}\);/);
    expect(js).toMatch(/window\.addEventListener\('pageshow',\s*\(\) => ensureMobileComposerVisible\(\)\)/);
    expect(js).toMatch(/document\.addEventListener\('touchend',\s*\(\) => ensureMobileComposerVisible\(\),\s*\{ passive:\s*true \}\)/);
  });

  it('keeps the composer controls in normal input-grid flow (no sticky offset that hides buttons)', () => {
    expect(css).toMatch(/#messageInputArea \.composer-controls,\s*\n\s*#messageInputArea \.flex\.justify-between>div\.flex\.items-center\s*\{[\s\S]*?display:\s*contents\s*!important;/);
    expect(css).not.toMatch(/#messageInputArea \.composer-action-row\s*\{[\s\S]*?position:\s*sticky;/);
    expect(css).not.toMatch(/#messageInputArea \.composer-action-row\s*\{[\s\S]*?bottom:\s*calc\(\s*-/);
  });

  it('keeps rotated phones height-constrained with chat scrolling and compact composer controls', () => {
    expect(css).toMatch(/@media \(pointer:\s*coarse\) and \(orientation:\s*landscape\) and \(max-height:\s*600px\)/);
    expect(css).toMatch(/@media \(pointer:\s*coarse\) and \(orientation:\s*landscape\) and \(max-height:\s*600px\)[\s\S]*?html:has\(#dashboardRoot\),\s*\n\s*body:has\(#dashboardRoot\)\s*\{[\s\S]*?overflow:\s*hidden\s*!important;/);
    expect(css).toMatch(/@media \(pointer:\s*coarse\) and \(orientation:\s*landscape\) and \(max-height:\s*600px\)[\s\S]*?#conversationArea\s*\{[\s\S]*?overflow-y:\s*auto\s*!important;/);
    expect(css).toMatch(/@media \(pointer:\s*coarse\) and \(orientation:\s*landscape\) and \(max-height:\s*600px\)[\s\S]*?#messageInputArea\s*\{[\s\S]*?width:\s*100%\s*!important;/);
    expect(css).toMatch(/@media \(pointer:\s*coarse\) and \(orientation:\s*landscape\) and \(max-height:\s*600px\)[\s\S]*?#messageInputArea \.mobile-agent-status-strip\s*\{[\s\S]*?position:\s*relative;/);
    expect(css).toMatch(/@media \(pointer:\s*coarse\) and \(orientation:\s*landscape\) and \(max-height:\s*600px\)[\s\S]*?#messageInputArea #userMessageForm\s*\{[\s\S]*?grid-template-columns:\s*1\.95rem 1\.95rem 1\.95rem 1\.95rem minmax\(0,\s*1fr\) 2\.15rem;/);
    expect(css).toMatch(/@media \(pointer:\s*coarse\) and \(orientation:\s*landscape\) and \(max-height:\s*600px\)[\s\S]*?#messageInputArea #generalFileUploadLabel,[\s\S]*?#messageInputArea #userMessageSend\s*\{[\s\S]*?position:\s*relative\s*!important;/);
    expect(css).toMatch(/@media \(pointer:\s*coarse\) and \(orientation:\s*landscape\) and \(max-height:\s*600px\)[\s\S]*?#messageInputArea #agentConfigContainer,[\s\S]*?#messageInputArea #userMessageSend\s*\{[\s\S]*?margin-bottom:\s*0\.5rem;/);
    expect(css).toMatch(/@media \(pointer:\s*coarse\) and \(orientation:\s*landscape\) and \(max-height:\s*600px\)[\s\S]*?#messageInputArea #userMessageSend \.send-spaceship-icon\s*\{[\s\S]*?width:\s*1\.02rem;/);
    expect(css).not.toMatch(/content:\s*'✈'/);
  });

  it('height-constrains wide mobile browsers so message history scrolls inside chat', () => {
    expect(css).toMatch(/@media \(pointer:\s*coarse\) and \(min-width:\s*768px\) and \(max-width:\s*1180px\)/);
    expect(css).toMatch(/@media \(pointer:\s*coarse\) and \(min-width:\s*768px\) and \(max-width:\s*1180px\)[\s\S]*?html:has\(#dashboardRoot\),\s*\n\s*body:has\(#dashboardRoot\)\s*\{[\s\S]*?overflow:\s*hidden\s*!important;/);
    expect(css).toMatch(/@media \(pointer:\s*coarse\) and \(min-width:\s*768px\) and \(max-width:\s*1180px\)[\s\S]*?#dashboardRoot > \.dashboard-main-grid\s*\{[\s\S]*?height:\s*100%\s*!important;/);
    expect(css).toMatch(/@media \(pointer:\s*coarse\) and \(min-width:\s*768px\) and \(max-width:\s*1180px\)[\s\S]*?\.dashboard-main-grid > #multiChatContainer > \.chat-tile--main\s*\{[\s\S]*?max-height:\s*100%\s*!important;/);
    expect(css).toMatch(/@media \(pointer:\s*coarse\) and \(min-width:\s*768px\) and \(max-width:\s*1180px\)[\s\S]*?#conversationArea\s*\{[\s\S]*?overflow-y:\s*auto\s*!important;/);
    expect(css).toMatch(/@media \(pointer:\s*coarse\) and \(min-width:\s*768px\) and \(max-width:\s*1180px\)[\s\S]*?#messageInputArea\s*\{[\s\S]*?position:\s*absolute\s*!important;/);
  });

  it('binds list toggle controls outside dock initialization path', () => {
    expect(js).toMatch(/function bindMobileListToggleControls\(\)/);
    expect(js).toMatch(/if \(isMobileListOnlyMode\(\)\)\s*\{[\s\S]*?bindMobileListToggleControls\(\);/);
  });

  it('does not render or restore the removed All Chats list entry', () => {
    expect(dashboard).not.toMatch(/id="allChatsListItem"/);
    expect(js).not.toMatch(/setAttribute\('data-agent-id', '__ALL__'\)/);
    expect(js).toMatch(/if \(lastAgentId === '__ALL__'\) \{[\s\S]*?localStorage\.removeItem\(LAST_AGENT_STORAGE_KEY\);/);
  });

  it('folds non-essential mobile header and nav actions behind compact menus', () => {
    expect(dashboard).toMatch(/class="council-header-title[^"]*">Council Chamber<\/h2>/);
    expect(dashboard).toMatch(/id="mobileCouncilActionsToggle"/);
    expect(dashboard).toMatch(/id="councilHeaderActions" class="council-header-actions/);
    expect(dashboard).toMatch(/id="mobileGroupManagementBtn"/);
    expect(layout).toMatch(/id="mobileNavActionsToggle"/);
    expect(layout).toMatch(/id="navLogoutLink"/);
    expect(css).toMatch(/#mobileHeader \.council-header-title\s*\{[\s\S]*?display:\s*none\s*!important;/);
    expect(css).toMatch(/#mobileHeader \.council-header-actions\s*\{[\s\S]*?display:\s*none\s*!important;/);
    expect(css).toMatch(/body\.mobile-council-actions-open #mobileHeader \.council-header-actions\s*\{[\s\S]*?display:\s*flex\s*!important;/);
    expect(css).toMatch(/@media \(max-width:\s*767px\)[\s\S]*?#groupManagementFab\s*\{[\s\S]*?display:\s*none\s*!important;/);
    expect(css).toMatch(/#mobileHeader \.mobile-group-management-action\s*\{[\s\S]*?display:\s*flex\s*!important;/);
    expect(layout).toMatch(/id="mobileNavActionsMenu" class="mobile-nav-actions-menu"/);
    expect(css).toMatch(/nav \.nav-right-buttons > :not\(#mobileNavActionsToggle\):not\(#mobileNavActionsMenu\):not\(\.fast-mode-nav-cluster\)\s*\{[\s\S]*?display:\s*none\s*!important;/);
    expect(css).toMatch(/nav \.mobile-nav-actions-menu\s*\{[\s\S]*?display:\s*none\s*!important;/);
    expect(css).toMatch(/body\.mobile-nav-actions-open nav \.mobile-nav-actions-menu\s*\{[\s\S]*?position:\s*fixed;[\s\S]*?flex-direction:\s*column;[\s\S]*?width:\s*min\(18rem,\s*calc\(100vw - 1\.5rem\)\);/);
    expect(css).toMatch(/body\.mobile-nav-actions-open nav \.mobile-nav-actions-menu > #settingsButtonWrapper,[\s\S]*?body\.mobile-nav-actions-open nav \.mobile-nav-actions-menu > #navLogoutLink\s*\{[\s\S]*?display:\s*flex\s*!important;/);
    expect(css).toMatch(/body\.mobile-nav-actions-open nav \.nav-right-buttons\s*\{[^}]*position:\s*relative;/);
    expect(css).not.toMatch(/body\.mobile-nav-actions-open nav \.nav-right-buttons\s*\{[^}]*position:\s*absolute;/);
    expect(js).toMatch(/function bindMobileOverflowActionControls\(\)/);
    expect(js).toMatch(/buttonId:\s*'mobileCouncilActionsToggle'/);
    expect(js).toMatch(/buttonId:\s*'mobileNavActionsToggle'/);
    expect(js).toMatch(/mobileGroupBtn\.addEventListener\('click'/);
    expect(js).toMatch(/toggleGroupManagementMenu\(mobileGroupBtn\)/);
  });

  it('keeps the mobile Menu button and dropdown active across the full mobile shell breakpoint', () => {
    expect(css).toMatch(/@media \(max-width:\s*1023px\),\s*\(pointer:\s*coarse\) and \(max-width:\s*1180px\)[\s\S]*?nav \.mobile-nav-actions-toggle\s*\{[\s\S]*?display:\s*inline-flex\s*!important;/);
    expect(css).toMatch(/@media \(max-width:\s*1023px\),\s*\(pointer:\s*coarse\) and \(max-width:\s*1180px\)[\s\S]*?nav \.nav-right-buttons > :not\(#mobileNavActionsToggle\):not\(#mobileNavActionsMenu\):not\(\.fast-mode-nav-cluster\)\s*\{[\s\S]*?display:\s*none\s*!important;/);
    expect(css).toMatch(/@media \(max-width:\s*1023px\),\s*\(pointer:\s*coarse\) and \(max-width:\s*1180px\)[\s\S]*?body\.mobile-nav-actions-open nav \.mobile-nav-actions-menu\s*\{[\s\S]*?display:\s*flex\s*!important;[\s\S]*?position:\s*fixed;/);
  });

  it('collapses the main interactive Agent Space when the mobile composer gains focus', () => {
    expect(js).toMatch(/function collapseMainInteractiveSpaceForMobileFocus\(\)/);
    expect(js).toMatch(/if \(!isMobileListOnlyMode\(\) \|\| !selectedAgentId\) return;/);
    expect(js).toMatch(/setMainInteractiveContentVisibility\(false\);/);
    expect(js).toMatch(/userMessageInput\.addEventListener\('focus',\s*\(\) => \{[\s\S]*?collapseMainInteractiveSpaceForMobileFocus\(\);/);
  });

  it('uses mobile conversation swipes as chat history back and forward navigation', () => {
    expect(js).toMatch(/let chatNavigationHistory = \[\]/);
    expect(js).toMatch(/let chatNavigationIndex = -1/);
    expect(js).toMatch(/function recordChatNavigation\(agentId,\s*agentName = '',\s*metadata = \{\}\)/);
    expect(js).toMatch(/function navigateChatHistoryBy\(delta\)/);
    expect(js).toMatch(/recordChatNavigation\(agentId,\s*resolvedAgentName,\s*metadata\)/);
    expect(js).toMatch(/dx > 0[\s\S]*?navigateChatHistoryBy\(-1\)/);
    expect(js).toMatch(/dx > 0[\s\S]*?else \{[\s\S]*?navigateChatHistoryBy\(1\)/);
    expect(js).not.toMatch(/dx > 0[\s\S]*?navigateAgentListBy\(-1\)/);
  });

  it('removes pin-chat affordances from mobile and touch layouts', () => {
    expect(css).toMatch(/@media \(max-width:\s*1023px\),\s*\(pointer:\s*coarse\) and \(max-width:\s*1180px\)[\s\S]*?#pinToSideBtn,[\s\S]*?\.agent-list-pin-btn,[\s\S]*?#chatAreaDropOverlay\s*\{[\s\S]*?display:\s*none\s*!important;/);
    expect(js).toMatch(/function shouldSuppressPinControlsForMobile\(\)/);
    expect(js).toMatch(/isMobileListOnlyMode\(\) \|\| coarseMobileViewport/);
    expect(js).toMatch(/pinBtn\.classList\.toggle\('hidden',\s*!hasSelectedAgent \|\| shouldHideForMobile\)/);
    expect(js).toMatch(/if \(!item \|\| shouldSuppressPinControlsForMobile\(\)\) return;/);
  });

  it('forces chrome visible when expanding list', () => {
    expect(js).toMatch(/if \(expanded\)\s*\{[\s\S]*?setMobileChromeCollapsed\(false\);/);
  });

  it('keeps the mobile agent search empty and unfocused after selecting an agent', () => {
    expect(dashboard).toMatch(/id="agentListSearchInput"[\s\S]*?name="agent_search_query"[\s\S]*?readonly[\s\S]*?autocomplete="off"[\s\S]*?data-lpignore="true"[\s\S]*?data-1p-ignore="true"[\s\S]*?data-bwignore="true"/);
    expect(js).toMatch(/function clearAgentListSearch\(\{ blur = false,\s*update = true \} = \{\}\)/);
    expect(js).toMatch(/agentListSearchQuery = '';/);
    expect(js).toMatch(/if \(blur && document\.activeElement === searchInput\) \{[\s\S]*?searchInput\.blur\(\);/);
    expect(js).toMatch(/if \(isMobileListOnlyMode\(\)\) \{[\s\S]*?clearAgentListSearch\(\{ blur:\s*true,\s*update:\s*true \}\);[\s\S]*?setMobileListExpanded\(false\);/);
    expect(js).toMatch(/data-lpignore',\s*'true'/);
    expect(js).toMatch(/data-1p-ignore',\s*'true'/);
    expect(js).toMatch(/function clearAgentListSearch[\s\S]*?searchInput\.readOnly = true;/);
    expect(js).toMatch(/const unlockSearchInput = \(\) => \{\s*searchInput\.readOnly = false;/);
    expect(js).toMatch(/searchInput\.addEventListener\('pointerdown', unlockSearchInput\);/);
    expect(js).toMatch(/searchInput\.addEventListener\('focus', unlockSearchInput\);/);
  });

  it('defines the required mobile feature checklist and fast-mode test surface', () => {
    const checklistPath = path.join(__dirname, '../../docs/MOBILE_FEATURE_CHECKLIST_2026-05-18.md');
    const checklist = fs.readFileSync(checklistPath, 'utf8');
    expect(checklist).toMatch(/## Required Mobile Features/);
    expect(checklist).toMatch(/Composer visibility/);
    expect(checklist).toMatch(/Scroll to latest/);
    expect(checklist).toMatch(/Correct active chat/);
    expect(checklist).toMatch(/Fast Mode/);
  });

  it('adds a mobile-only Fast Mode toggle that preserves core chat controls', () => {
    expect(layout).toMatch(/id="mobileFastModeToggle"/);
    expect(layout).toMatch(/mobile-fast-mode-toggle__switch/);
    expect(layout).toMatch(/mobile-fast-mode-toggle__thumb/);
    expect(js).toMatch(/const DASHBOARD_FAST_MODE_STORAGE_KEY = 'dashboardFastMode'/);
    expect(js).toMatch(/function getDashboardLayoutMode\(\)/);
    expect(js).toMatch(/function setupMobileFastModeToggle\(\)/);
    expect(js).toMatch(/document\.body\.classList\.toggle\('dashboard-fast-mode'/);
    expect(js).toMatch(/window\.localStorage\?\.setItem\(DASHBOARD_FAST_MODE_STORAGE_KEY,\s*'1'\)/);
    expect(css).toMatch(/\.mobile-fast-mode-toggle\s*\{[\s\S]*?display:\s*none;/);
    expect(css).toMatch(/body\.mobile-nav-actions-open nav \.mobile-nav-actions-menu > #mobileFastModeToggle\s*\{[\s\S]*?display:\s*flex\s*!important;/);
    expect(css).toMatch(/\.mobile-fast-mode-toggle\[aria-pressed="true"\] \.mobile-fast-mode-toggle__thumb\s*\{[\s\S]*?transform:\s*translateX/);
    expect(css).not.toMatch(/\.mobile-fast-mode-toggle\s*\{[^}]*position:\s*absolute/);
    expect(dashboard).not.toMatch(/id="mobileFastModeToggle"/);
    expect(css).toMatch(/body\.dashboard-fast-mode #mainInteractiveSpace,[\s\S]*?body\.dashboard-fast-mode #interAgentStatsInline,[\s\S]*?body\.dashboard-fast-mode \.message-tts-btn,[\s\S]*?body\.dashboard-fast-mode \.message-info-btn\s*\{[\s\S]*?display:\s*none\s*!important;/);
    expect(css).toMatch(/body\.dashboard-fast-mode\[data-agent-selected="true"\]:not\(\[data-all-chats-view="true"\]\) #messageInputArea,[\s\S]*?display:\s*block\s*!important/);
    expect(css).toMatch(/body\.dashboard-fast-mode #messageInputArea #agentConfigBtn\s*\{[\s\S]*?display:\s*none\s*!important;/);
    expect(css).toMatch(/body\.dashboard-fast-mode #messageInputArea \.mobile-agent-status-strip\s*\{[\s\S]*?pointer-events:\s*auto;[\s\S]*?cursor:\s*pointer;/);
    expect(css).toMatch(/#messageInputArea #agentConfigContainer/);
    expect(css).toMatch(/#messageInputArea #agentStopBtn/);
    expect(css).toMatch(/#messageInputArea #generalFileUploadLabel/);
    expect(css).toMatch(/#messageInputArea #imageUploadLabel/);
    expect(css).toMatch(/#messageInputArea #userMessageSend/);
    expect(js).toMatch(/configStrip\?\.addEventListener\('click', async \(\) => \{/);
    expect(js).toMatch(/if \(!isDashboardFastModeEnabled\(\)\) return;/);
    expect(js).toMatch(/configStrip\?\.setAttribute\('aria-expanded', isOpen \? 'true' : 'false'\);/);
  });

  it('Fast Mode hides the council 3-dots row and agents-count row so only the top nav row stays visible', () => {
    // The layout applies the persisted class before dashboard markup paints, so
    // the Total / Need Attention / Urgent row does not flash in Fast Mode.
    expect(layout).toMatch(/localStorage\.getItem\('dashboardFastMode'\) === '1'/);
    expect(layout).toMatch(/document\.body\.classList\.add\('dashboard-fast-mode'\)/);
    expect(layout).toMatch(/window\.matchMedia\('\(max-width: 1023px\)'\)/);
    // The original mobile council header chrome (title, nav arrows, collapse, minimize)
    // and the in-row 3-dots toggle are all hidden in fast mode.
    expect(css).toMatch(/body\.dashboard-fast-mode #mobileHeader > \.flex,[\s\S]*?body\.dashboard-fast-mode #mobileHeader \.council-header-title,[\s\S]*?body\.dashboard-fast-mode #mobileHeader #headerNavLeft,[\s\S]*?body\.dashboard-fast-mode #mobileHeader #headerNavRight,[\s\S]*?body\.dashboard-fast-mode #mobileHeader #collapseMobileListBtn,[\s\S]*?body\.dashboard-fast-mode #mobileHeader #minimizeCouncilBtn,[\s\S]*?body\.dashboard-fast-mode #mobileHeader \.mobile-council-actions-toggle\s*\{[\s\S]*?display:\s*none\s*!important;/);
    // The whole agents-count row (Total / Need Attention / Urgent) is hidden.
    expect(css).toMatch(/body\.dashboard-fast-mode #mobileStatsToggle\s*\{[\s\S]*?display:\s*none\s*!important;/);
    // Agent list title/count chip stays hidden so the list itself takes priority.
    expect(css).toMatch(/body\.dashboard-fast-mode \.agent-list-title,[\s\S]*?body\.dashboard-fast-mode \.agent-list-count\s*\{[\s\S]*?display:\s*none\s*!important;/);
    // #mobileHeader stays rendered (zero-height) so the council actions dropdown still anchors.
    expect(css).toMatch(/body\.dashboard-fast-mode #mobileHeader\s*\{[\s\S]*?display:\s*block\s*!important;[\s\S]*?height:\s*0\s*!important;/);
  });

  it('Fast Mode injects urgent/attention indicators into the top nav and keeps hidden actions under Menu', () => {
    // JS-side injection lives in ensureFastModeNavCluster, called from setupMobileFastModeToggle.
    expect(js).toMatch(/function ensureFastModeNavCluster\(\)/);
    expect(js).toMatch(/cluster\.id\s*=\s*'fastModeNavCluster'/);
    expect(js).toMatch(/id="fastModeUrgentIndicator"/);
    expect(js).toMatch(/id="fastModeAttentionIndicator"/);
    expect(js).not.toMatch(/id="fastModeCouncilActionsBtn"/);
    expect(js).toMatch(/function updateFastModeNavCluster\(/);
    expect(js).toMatch(/function getFastModeUnreadMessageCount\(agents = currentAgentList\)/);
    // Fast Mode uses the normal mobile Menu button to reveal the hidden council actions.
    expect(layout).toMatch(/id="mobileNavActionsToggle"/);
    expect(css).toMatch(/body\.dashboard-fast-mode\.mobile-nav-actions-open #mobileHeader \.council-header-actions\s*\{[\s\S]*?display:\s*flex\s*!important;/);
    expect(js).toMatch(/closest\?\.\('#mobileNavActionsToggle, nav \.nav-right-buttons, body\.dashboard-fast-mode #councilHeaderActions'\)/);
    expect(js).toMatch(/title="Unread messages — tap to view agents"/);
    // Fast Mode badge shows total unread messages, not just the number of attention agents.
    expect(js).toMatch(/const unreadMessageCount = getFastModeUnreadMessageCount\(currentAgentList\);/);
    expect(js).toMatch(/updateFastModeNavCluster\(\{\s*urgent:\s*urgentCount,\s*attention:\s*unreadMessageCount\s*\}\)/);
  });

  it('Fast Mode reveals the injected cluster despite the mobile-only nav-right-buttons hide rule', () => {
    expect(css).toMatch(/\.fast-mode-nav-cluster\s*\{[\s\S]*?display:\s*none;/);
    expect(css).toMatch(/body\.dashboard-fast-mode \.fast-mode-nav-cluster\s*\{[\s\S]*?display:\s*inline-flex;/);
    expect(css).toMatch(/body\.dashboard-fast-mode nav \.nav-right-buttons > \.fast-mode-nav-cluster\s*\{[\s\S]*?display:\s*inline-flex\s*!important;/);
    expect(css).toMatch(/\.fast-mode-nav-cluster__indicator\[data-count="0"\]\s*\{[\s\S]*?display:\s*none\s*!important;/);
    expect(css).toMatch(/body\.dashboard-fast-mode #agentListPanel:not\(\.mobile-expanded\)\s*\{[\s\S]*?max-height:\s*0\s*!important;[\s\S]*?height:\s*0\s*!important;[\s\S]*?pointer-events:\s*none\s*!important;/);
    expect(css).toMatch(/body\.dashboard-fast-mode #agentListPanel\.mobile-expanded\s*\{[\s\S]*?max-height:\s*min\(38vh,\s*17rem\)\s*!important;[\s\S]*?pointer-events:\s*auto\s*!important;/);
    // Council actions dropdown floats near the top nav when opened from the Menu button in fast mode.
    expect(css).toMatch(/body\.dashboard-fast-mode\.mobile-nav-actions-open #mobileHeader \.council-header-actions\s*\{[\s\S]*?position:\s*fixed\s*!important;[\s\S]*?width:\s*min\(18rem,\s*calc\(100vw - 1\.5rem\)\);/);
  });

  it('Fast Mode urgent/attention indicators are clickable buttons that open an agent jump list', () => {
    // The badges must be rendered as <button> elements so they are tappable,
    // not silent <span>s (regression from the original implementation).
    expect(js).toMatch(/<button type="button" id="fastModeUrgentIndicator"/);
    expect(js).toMatch(/<button type="button" id="fastModeAttentionIndicator"/);
    expect(js).toMatch(/aria-haspopup="true"/);
    // Click handlers and popover plumbing must be present.
    expect(js).toMatch(/function bindFastModeNavClusterHandlers\(\)/);
    expect(js).toMatch(/function openFastModeAlertPanel\(/);
    expect(js).toMatch(/function closeFastModeAlertPanel\(\)/);
    expect(js).toMatch(/function renderFastModeAlertPanel\(/);
    // Agent names from /api/user/agents arrive as "name"; the popover must
    // not fall back to UUID-like agentId text when a display name exists.
    expect(js).toMatch(/function getFastModeAlertAgentName\(agent = \{\}\)/);
    expect(js).toMatch(/agent\.name \|\| agent\.agentName \|\| agent\.agent_name/);
    expect(js).toMatch(/nameSpan\.textContent = agentName \|\| 'Unnamed agent'/);
    // Tapping a list row should navigate to that agent.
    expect(js).toMatch(/openAgentWithFeedback\(aid, aname, \{ forceMainSelection: true \}\)/);
    // Outside-click and Escape close the popover.
    expect(js).toMatch(/fastModeAlertDismissBound/);
    // Popover styling exists.
    expect(css).toMatch(/\.fast-mode-alert-panel\s*\{[\s\S]*?position:\s*fixed;[\s\S]*?z-index:\s*240;/);
    expect(css).toMatch(/\.fast-mode-alert-panel\.hidden\s*\{[\s\S]*?display:\s*none\s*!important;/);
    expect(css).toMatch(/\.fast-mode-alert-panel__item\s*\{[\s\S]*?cursor:\s*pointer;/);
  });

  it('Fast Mode exposes a chat and group list button beside the selected agent name', () => {
    expect(dashboard).toMatch(/id="fastModeChatListToggle"/);
    expect(css).toMatch(/\.fast-mode-chat-list-toggle\s*\{[\s\S]*?display:\s*none;/);
    expect(css).toMatch(/body\.dashboard-fast-mode \.fast-mode-chat-list-toggle\s*\{[\s\S]*?display:\s*inline-flex;/);
    expect(css).toMatch(/\.fast-mode-chat-list-toggle\s*\{[\s\S]*?width:\s*2\.35rem;[\s\S]*?height:\s*2\.35rem;/);
    expect(css).toMatch(/@media \(max-width:\s*1023px\),\s*\(pointer:\s*coarse\) and \(max-width:\s*1180px\)[\s\S]*?\.fast-mode-chat-list-toggle\s*\{[\s\S]*?width:\s*2\.5rem;[\s\S]*?height:\s*2\.5rem;/);
    expect(js).toMatch(/const fastModeChatListToggle = document\.getElementById\('fastModeChatListToggle'\)/);
    expect(js).toMatch(/if \(activeGroupId\) \{[\s\S]*?exitGroupView\(\);[\s\S]*?\}/);
    expect(js).toMatch(/updateAgentListPanel\(currentAgentList\);[\s\S]*?setMobileListExpanded\(true\);/);
  });

  it('keeps the standard mobile agent-list button visible and finger-sized across mobile shell widths', () => {
    expect(css).toMatch(/@media \(max-width:\s*1023px\),\s*\(pointer:\s*coarse\) and \(max-width:\s*1180px\)[\s\S]*?#collapseMobileListBtn\s*\{[\s\S]*?width:\s*2\.45rem;[\s\S]*?height:\s*2\.45rem;[\s\S]*?min-width:\s*2\.45rem;[\s\S]*?min-height:\s*2\.45rem;/);
    expect(css).toMatch(/#collapseMobileListBtn svg\s*\{[\s\S]*?width:\s*1\.18rem;[\s\S]*?height:\s*1\.18rem;/);
  });

  it('avoids rebuilding hidden orbit and dock DOM while Fast Mode is active', () => {
    expect(js).toMatch(/function isDashboardFastModeActive\(\)/);
    expect(js).toMatch(/const FAST_MODE_AGENT_RENDER_MIN_INTERVAL_MS = 12000/);
    expect(js).toMatch(/const FAST_MODE_AGENT_POLL_CACHE_TTL = 12000/);
    expect(js).toMatch(/function getAgentPollCacheTtl\(\)/);
    expect(js).toMatch(/function shouldSkipAgentListRender\(agents\)/);
    expect(js).toMatch(/function shouldRenderAgentListPanelInFastMode\(\)/);
    expect(js).toMatch(/function clearCollapsedFastModeAgentListPanel\(\)/);
    expect(js).toMatch(/updateMobileDock\(currentAgentList,\s*\{ render:\s*!fastModeActive \}\)/);
    expect(js).toMatch(/if \(fastModeActive\) \{[\s\S]*?agentSeatsContainer\.innerHTML = '';/);
    expect(js).toMatch(/if \(shouldRenderAgentListPanelInFastMode\(\)\) \{[\s\S]*?updateAgentListPanel\(currentAgentList\);[\s\S]*?\} else \{[\s\S]*?clearCollapsedFastModeAgentListPanel\(\);/);
    expect(js).toMatch(/function getCachedMarbleSvg\(agentId,\s*size,\s*agentName = '',\s*context = 'avatar'\)/);
  });

  it('does not auto-render full old chat history on mobile or Fast Mode', () => {
    expect(js).toMatch(/function shouldAutoLoadOlderMessages\(agentId\)/);
    expect(js).toMatch(/if \(isDashboardFastModeActive\(\)\) return false;/);
    expect(js).toMatch(/if \(isMobileListOnlyMode\(\)\) return false;/);
    expect(js).toMatch(/pointer:\s*coarse[\s\S]*max-width:\s*1180px/);
    expect(js).toMatch(/if \(data\.hasMore && shouldAutoLoadOlderMessages\(agentId\)\) \{[\s\S]*?loadOlderMessagesInBackground\(agentId,\s*requestToken\);/);
  });
});
