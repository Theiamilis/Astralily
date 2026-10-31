const stage = document.createElement('main')
stage.setAttribute('aria-label', 'Asset-free public stage placeholder')
stage.style.display = 'grid'
stage.style.placeItems = 'center'
stage.style.width = 'min(72vw, 360px)'
stage.style.aspectRatio = '1'
stage.style.borderRadius = '50%'
stage.style.background = 'radial-gradient(circle at 35% 30%, #fff7fc 0 10%, #f7acd1 28%, #a96de2 72%, #6948c9 100%)'
stage.style.boxShadow = '0 0 70px rgba(205, 87, 177, 0.35), inset 0 0 30px rgba(255, 255, 255, 0.65)'
stage.style.transition = 'transform 180ms ease-out'

const label = document.createElement('div')
label.textContent = 'Public stage placeholder'
label.style.padding = '0.55rem 0.85rem'
label.style.borderRadius = '999px'
label.style.background = 'rgba(255, 255, 255, 0.78)'
label.style.fontSize = '0.8rem'
label.style.fontWeight = '700'
label.style.letterSpacing = '0.03em'
stage.append(label)
document.body.append(stage)

let pulse = 0
function animate() {
  pulse += 0.035
  stage.style.transform = `scale(${1 + Math.sin(pulse) * 0.018})`
  requestAnimationFrame(animate)
}
animate()

window.addEventListener('message', (event) => {
  if (event.origin !== window.location.origin || !event.data) return
  if (event.data.type === 'lily-live2d-cursor-reset') {
    stage.style.filter = ''
    return
  }
  if (event.data.type === 'lily-live2d-cursor') {
    stage.style.filter = 'saturate(1.08) brightness(1.04)'
  }
})
