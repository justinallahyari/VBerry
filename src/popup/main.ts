import { createApp } from 'vue'
import '@/shared/theme.css'
import './popup.css'
import App from '@/sidepanel/App.vue'

// Mirror Bitwarden's PopupSizeService: set explicit body width in JS before mount
document.body.style.width = '500px'

createApp(App, { mode: 'popup' }).mount('#app')
