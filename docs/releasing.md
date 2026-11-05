# Release and Homebrew tap preparation

Pond uses the same manual tap transfer as Parakatt: publish a tagged GitHub release, then update `asabla/homebrew-tap` with its cask. No tap token or automatic push is needed.

## Validate the release candidate

Run the normal Go, JavaScript, lint and type checks. Then:

```sh
goreleaser check
goreleaser release --snapshot --clean --skip=publish,announce
```

The snapshot builds macOS and Linux binaries for arm64 and amd64, archives them with the README, license and both examples, and generates `dist/homebrew/Casks/pond.rb`. Inspect each archive and verify that it contains the seed scripts and `04_workbench.pond.json` files, with no `.pond` data. Snapshot URLs are previews and cannot be installed from GitHub Releases.

## Publish the first release

Merge the reviewed changes and run CI before tagging. For a first stable release, `v0.1.0` is an example tag:

```sh
git tag v0.1.0
git push origin v0.1.0
gh run list --workflow release.yml
gh release view v0.1.0 --repo asabla/pond
```

The workflow keeps the release in draft while it attaches `pond.rb`, then publishes the complete release. It must contain `pond.rb`, `checksums.txt`, and these archives:

```text
pond_0.1.0_darwin_arm64.tar.gz
pond_0.1.0_darwin_amd64.tar.gz
pond_0.1.0_linux_arm64.tar.gz
pond_0.1.0_linux_amd64.tar.gz
```

Creating a snapshot or preparing a tap file does not publish the release. Do not copy snapshot hashes or placeholder values into an active cask.

## Transfer the cask into the tap

In the `homebrew-tap` checkout:

```sh
python3 scripts/update_pond.py v0.1.0
git diff -- Casks/pond.rb
brew style Casks/pond.rb
```

The helper requires a published stable release. It downloads the generated cask, checksum file and all four archives. It checks the version, tag, URLs, cask hashes and archive bytes, then normalizes Homebrew formatting before it writes `Casks/pond.rb`. An error leaves the current cask unchanged. Review and commit the resulting file, then push the tap change.

`Casks/pond.rb.in` in the tap is a first-release preview. Its placeholders are intentional; Homebrew ignores it. The generated `Casks/pond.rb` is the installable entry after the release exists and the verified tap change is pushed.

## Install and try the examples

After the release and tap update are published:

```sh
brew tap asabla/tap
brew update
brew audit --cask --online asabla/tap/pond
brew install --cask asabla/tap/pond
pond version
cp -R "$(brew --caskroom pond)/0.1.0/examples" ./pond-examples
pond ./pond-examples/social
```

Use the installed version in the copy path; Homebrew prints this command with the actual version during installation. Start `pond ./pond-examples/shop` in a second terminal. Each context has two saved graphs and two saved queries. Docker must be running; users can use Docker Desktop, OrbStack or colima. Uninstalling the cask keeps your copied contexts and their data; `--zap` removes only Pond's recent-context list.
