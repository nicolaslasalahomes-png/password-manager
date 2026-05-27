/**
 * Service worker — sets up an idle alarm that clears the in-memory session
 * after 10 minutes of inactivity. Also wipes everything when all browser
 * windows close (service worker is killed soon after).
 */

const ALARM_NAME = 'idle-lock-check'
const IDLE_CHECK_INTERVAL_MIN = 1

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: IDLE_CHECK_INTERVAL_MIN })
})

chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: IDLE_CHECK_INTERVAL_MIN })
})

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== ALARM_NAME) return
  void (async () => {
    const data = await chrome.storage.session.get(['last_used'])
    const lastUsed = data.last_used as number | undefined
    if (!lastUsed) return
    if (Date.now() - lastUsed > 10 * 60 * 1000) {
      await chrome.storage.session.clear()
    }
  })()
})

export {}
