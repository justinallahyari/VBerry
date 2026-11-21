import { createApp } from 'vue'
import '@/shared/theme.css'
import PopupApp from './PopupApp.vue'

// Mirror Bitwarden's PopupSizeService: set explicit body width in JS before mount
document.body.style.width = '500px'

createApp(PopupApp).mount('#app')
