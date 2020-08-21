/* globals beaker */
import { html, css } from 'beaker://app-stdlib/vendor/lit-element/lit-element.js'
import { BasePopup } from 'beaker://app-stdlib/js/com/popups/base.js'
import { joinPath } from 'beaker://app-stdlib/js/strings.js'
import popupsCSS from 'beaker://app-stdlib/css/com/popups.css.js'
import '../post-composer.js'

// exported api
// =

export class NewPostPopup extends BasePopup {
  constructor (opts) {
    super()
    this.driveUrl = opts.driveUrl
  }

  static get properties () {
    return {
    }
  }

  static get styles () {
    return [popupsCSS, css`
    .popup-inner {
      width: 640px;
      border-radius: 8px;
    }
    .popup-inner .body {
      padding: 14px 14px 10px 12px;
    }
    `]
  }

  get shouldShowHead () {
    return false
  }

  get shouldCloseOnOuterClick () {
    return false
  }

  get shouldCloseOnEscape () {
    return false
  }

  // management
  //

  static async create (opts) {
    return BasePopup.create(NewPostPopup, opts)
  }

  static destroy () {
    return BasePopup.destroy('new-post-popup')
  }

  // rendering
  // =

  renderTitle () {
    return `New post`
  }

  renderBody () {
    return html`
      <beaker-post-composer
        @publish=${this.onPublish}
        @cancel=${this.onCancel}
      ></beaker-post-composer>
    `
  }

  // events
  // =

  async onPublish (e) {
    this.dispatchEvent(new CustomEvent('resolve'))
  }

  async onCancel (e) {
    this.dispatchEvent(new CustomEvent('reject'))
  }
}

customElements.define('new-post-popup', NewPostPopup)