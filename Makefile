bundle := dist/screen-touchpad@codex.local.shell-extension.zip

.PHONY: pack install

pack:
	mkdir -p dist
	gnome-extensions pack --force --extra-source=rotation.js --out-dir=dist extension

install: pack
	gnome-extensions install --force "$(bundle)"
