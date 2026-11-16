// Weekly sync of mruwzum/ring with dgreif/ring upstream, then build + test + lint,
// then deploy packages/homebridge-ring to Homebridge on raspi5.
//
// Runs on the `rpi` label (the Jenkins master on raspi5) so the deploy is local: no
// cross-machine copy, no second set of SSH keys. Node comes from Homebridge's own
// install at /opt/homebridge/bin — Jenkins has no node of its own on this box.
//
// Deploy is done by /usr/local/bin/deploy-ring-fork.sh via sudo. That script owns the
// backup, the atomic swap, the restart, the log check and the rollback. Jenkins only
// hands it a tarball. Nothing else in this pipeline touches /var/lib/homebridge.
//
// STABLE ONLY (Miguel, 16 Nov 2026). The fork follows upstream's stable releases. If the
// `version` of packages/homebridge-ring/package.json at upstream/main is a prerelease
// (contains "-", e.g. 15.0.0-beta.0) the run skips ONLY the upstream merge: it still
// builds, tests and lints main, and deploys the fork's own new commits when HEAD differs
// from the deploy marker (so an intercom fix pushed during a long beta is not stuck).
// It sends ONE Telegram note per new upstream version (the last notified version is kept
// in /var/tmp/ring-fork-beta-notified).
//
// NEXT STEP when 15.0.0 stable lands, in this order:
//   1. `git revert 4fc354a` on main. That commit reverted "Merge upstream/main ... adapt CI
//      to pnpm" (6d9e1ca), so git thinks upstream is already merged: without reverting the
//      revert, `git merge upstream/main` would bring only the commits after 152ea68 and leave
//      the pnpm move and the rest of 15.x undone, i.e. an inconsistent tree.
//   2. Then merge upstream (or the `upstream-15-beta` branch, see below).
//
// Upstream moved from npm to pnpm (dgreif/ring#1900,
// pnpm-lock.yaml, no package-lock.json). This Jenkinsfile still uses npm, so the merge
// would conflict and the build could not install. Branch `upstream-15-beta` of the fork
// holds the merge plus a pnpm-adapted Jenkinsfile. Until main has pnpm-lock.yaml, the
// sync stage fails early with an explicit message instead of a confusing merge conflict.
// To move on: merge `upstream-15-beta` into main (refresh it against upstream first).

pipeline {
    agent { label 'rpi' }

    options {
        buildDiscarder(logRotator(numToKeepStr: '10'))
        disableConcurrentBuilds()
        timeout(time: 60, unit: 'MINUTES')
    }

    triggers {
        // Mondays at 05:00. Outside the vida windows and well clear of the nightly
        // backups; if it breaks Homebridge, Miguel is asleep but the rollback is
        // automatic and the Telegram message is waiting for him.
        cron('0 5 * * 1')
    }

    parameters {
        booleanParam(
            name: 'DEPLOY',
            defaultValue: true,
            description: 'Deploy to Homebridge on raspi5 when build, test and lint are green. Untick for a dry run that only reports whether upstream moved.'
        )
        booleanParam(
            name: 'PUSH_MERGE',
            defaultValue: true,
            description: 'Push the merged upstream commits back to origin/main.'
        )
    }

    environment {
        PATH = "/opt/homebridge/bin:${env.PATH}"
        UPSTREAM_URL = 'https://github.com/dgreif/ring.git'
        TELEGRAM_CHAT_ID = '548445054'
        STAGE_TARBALL = '/var/tmp/ring-fork-deploy.tgz'
    }

    stages {

        stage('Checkout') {
            steps {
                script { env.CURRENT_STAGE = env.STAGE_NAME }
                checkout([
                    $class: 'GitSCM',
                    branches: [[name: 'main']],
                    userRemoteConfigs: [[credentialsId: 'mruwzum_git', url: 'git@github.com:mruwzum/ring.git']]
                ])
                // The workspace is reused between builds and these status files are untracked, so
                // they survive. A `.merge-conflict` left by build #25 (26 Oct 2026) made every later
                // failure notify as a merge conflict. Start each run without them.
                sh 'rm -f .merge-conflict .upstream-behind .upstream-changelog .head-sha .upstream-beta .needs-pnpm'
            }
        }

        stage('Sync upstream') {
            steps {
                script { env.CURRENT_STAGE = env.STAGE_NAME }
                sshagent(['mruwzum_git']) {
                    sh '''
                        set -e
                        git config pull.rebase false
                        git config user.email "ma.antolinbermudez@gmail.com"
                        git config user.name "Jenkins (raspi5)"

                        if ! git remote | grep -qx upstream; then
                            git remote add upstream "${UPSTREAM_URL}"
                        fi
                        git fetch upstream --tags

                        # Stable only (checked BEFORE the nothing-new exit, Codex 16 Nov 2026): a prerelease upstream is not MERGED.
                        # The fork's own commits still go through build, test and deploy (decided by the deploy marker).
                        UP_VERSION=$(git show upstream/main:packages/homebridge-ring/package.json \
                            | node -e 'process.stdout.write(String(JSON.parse(require("fs").readFileSync(0,"utf8")).version))')
                        echo "upstream/main homebridge-ring version: ${UP_VERSION}"
                        case "${UP_VERSION}" in
                            *-*)
                                echo "SKIP MERGE: upstream is at prerelease ${UP_VERSION}; the fork's own commits are still built and deployed."
                                echo "${UP_VERSION}" > .upstream-beta
                                echo 0 > .upstream-behind
                                : > .upstream-changelog
                                exit 0
                                ;;
                        esac

                        BEHIND=$(git rev-list --count HEAD..upstream/main)
                        echo "${BEHIND}" > .upstream-behind
                        echo "commits behind upstream/main: ${BEHIND}"

                        if [ "${BEHIND}" -eq 0 ]; then
                            echo "Nothing new upstream."
                            : > .upstream-changelog
                            exit 0
                        fi

                        git log --oneline --no-merges HEAD..upstream/main > .upstream-changelog
                        cat .upstream-changelog

                        # Stable, but upstream is on pnpm and this fork's main is still on npm.
                        if git cat-file -e upstream/main:pnpm-lock.yaml 2>/dev/null && [ ! -f pnpm-lock.yaml ]; then
                            echo "STOP: upstream ${UP_VERSION} uses pnpm and this Jenkinsfile uses npm. Needs the pnpm Jenkinsfile, see branch upstream-15-beta."
                            echo "${UP_VERSION}" > .needs-pnpm
                            exit 4
                        fi

                        # A conflicted merge stops the build here rather than half-applying.
                        # Miguel's intercom work and upstream touch the same files often
                        # enough that this is expected to happen sooner or later.
                        if ! git merge --no-edit upstream/main; then
                            git merge --abort || true
                            echo "MERGE CONFLICT" > .merge-conflict
                            exit 3
                        fi
                    '''
                }
            }
        }

        stage('Check deploy marker') {
            // Package/Deploy used to run every week regardless of whether HEAD had
            // moved since the last successful deploy — a needless Homebridge restart
            // on weeks with nothing new (28 Sep 2026, Miguel: "si no hay cambios...
            // no hace falta redesplegar"). The marker is the SHA deploy-ring-fork.sh
            // actually deployed last time, written by itself on success, not
            // ".upstream-behind": that only tracks upstream sync and would have
            // skipped today's fix, which was a manual push with BEHIND=0.
            steps {
                script { env.CURRENT_STAGE = env.STAGE_NAME }
                sh 'git rev-parse HEAD > .head-sha'
                script {
                    def headSha = readFile('.head-sha').trim()
                    def marker = '/var/tmp/ring-fork-deployed-sha'
                    def deployedSha = fileExists(marker) ? readFile(marker).trim() : ''
                    // Same content as what is deployed counts as deployed: a revert or a
                    // no-op merge changes the SHA but not the tree, and must not restart Homebridge.
                    def sameTree = false
                    if (deployedSha) {
                        sameTree = sh(returnStatus: true, script: '[ "$(git rev-parse HEAD^{tree})" = "$(git rev-parse "$(cat /var/tmp/ring-fork-deployed-sha)^{tree}" 2>/dev/null)" ]') == 0
                    }
                    env.NEEDS_DEPLOY = (headSha == deployedSha || sameTree) ? 'false' : 'true'
                    echo "HEAD ${headSha} vs last deployed ${deployedSha ?: '(none)'} -> NEEDS_DEPLOY=${env.NEEDS_DEPLOY}"
                }
            }
        }

        stage('Build, test, lint') {
            steps {
                script { env.CURRENT_STAGE = env.STAGE_NAME }
                sh '''
                    set -e
                    node -v
                    npm -v
                    npm ci
                    npm run build
                    npm test
                    npm run lint
                '''
            }
        }

        stage('Push merge') {
            when {
                allOf {
                    expression { params.PUSH_MERGE }
                    expression { readFile('.upstream-behind').trim() != '0' }
                }
            }
            steps {
                script { env.CURRENT_STAGE = env.STAGE_NAME }
                sshagent(['mruwzum_git']) {
                    sh 'git push origin HEAD:main'
                }
            }
        }

        stage('Package') {
            when { allOf { expression { params.DEPLOY }; expression { env.NEEDS_DEPLOY == 'true' } } }
            steps {
                script { env.CURRENT_STAGE = env.STAGE_NAME }
                sh '''
                    set -e
                    PKG_STAGE=$(mktemp -d)
                    trap 'rm -rf "$PKG_STAGE"' EXIT

                    # ring-client-api goes in from this repo's own build, not from npm:
                    # it is what the tests just ran against, and upstream fixes to it
                    # reach the raspi without waiting for dgreif to publish.
                    npm pack -w ring-client-api --pack-destination "$PKG_STAGE" >/dev/null
                    RCA=$(cd "$PKG_STAGE" && ls ring-client-api-*.tgz)

                    # Exactly what the plugin needs at runtime. lib/ is the tsc output,
                    # rebuilt from scratch by `npm run build`, so it cannot carry stale
                    # files from a previous revision.
                    mkdir "$PKG_STAGE/plugin"
                    cd packages/homebridge-ring
                    cp -a lib media config.schema.json package.json homebridge-ui "$PKG_STAGE/plugin/"

                    # Its production dependencies, installed here on the Pi so native and
                    # arch-specific ones (the ffmpeg binary) are the right build. The deploy
                    # used to swap lib/ only, so the raspi kept whatever npm had installed
                    # months ago: werift 0.22.4 against a declared 0.24.4 (24 Sep 2026).
                    cd "$PKG_STAGE/plugin"
                    npm pkg set "dependencies.ring-client-api=file:../$RCA"
                    npm install --omit=dev --no-audit --no-fund --no-package-lock
                    cp -a "$WORKSPACE/packages/homebridge-ring/package.json" package.json
                    test -x node_modules/ffmpeg-for-homebridge/ffmpeg
                    node --input-type=module -e "await import('$PKG_STAGE/plugin/lib/index.js')"

                    tar czf "${STAGE_TARBALL}" lib media config.schema.json package.json homebridge-ui node_modules
                    ls -l "${STAGE_TARBALL}"
                '''
            }
        }

        stage('Deploy to Homebridge') {
            when { allOf { expression { params.DEPLOY }; expression { env.NEEDS_DEPLOY == 'true' } } }
            steps {
                script { env.CURRENT_STAGE = env.STAGE_NAME }
                sh 'sudo -n /usr/local/bin/deploy-ring-fork.sh "${STAGE_TARBALL}" "$(cat .head-sha)"'
                script { env.DEPLOYED = 'true' }
            }
        }
    }

    post {
        always {
            sh 'rm -f "${STAGE_TARBALL}" || true'
        }
        success {
            script {
                def inBeta = fileExists('.upstream-beta')
                if (inBeta) {
                    def betaVersion = readFile('.upstream-beta').trim()
                    def notified = '/var/tmp/ring-fork-beta-notified'
                    def last = fileExists(notified) ? readFile(notified).trim() : ''
                    echo "Upstream is at prerelease ${betaVersion}: upstream not merged; the fork's own commits were still built (and deployed if new)."
                    if (last != betaVersion) {
                        // the marker only after Telegram accepted it, so a failed notice is retried next run (Codex 16 Nov 2026)
                        if (telegram("Ring: dgreif/ring está en ${betaVersion} (beta). No he mergeado nada de upstream, solo mergeo versiones estables. Lo propio de tu fork sí se compila y se despliega si hay cambios.")) {
                            writeFile file: notified, text: betaVersion + '\n'
                        }
                    } else {
                        echo "Telegram note for ${betaVersion} already sent, not repeating."
                    }
                    // Quiet weeks: in beta with nothing deployed there is nothing else to say.
                    if (env.DEPLOYED != 'true') { return }
                }
                def behind = fileExists('.upstream-behind') ? readFile('.upstream-behind').trim() : '?'
                def log = fileExists('.upstream-changelog') ? readFile('.upstream-changelog').trim() : ''

                // Whether the raspi was touched depends on the Deploy stage having run,
                // NOT on whether upstream moved. The first version tied the two together
                // and told Miguel "no he tocado la raspi" on a run that had just deployed.
                def raspi = (env.DEPLOYED == 'true')
                    ? "Desplegado en homebridge de la raspi5."
                    : (params.DEPLOY && env.NEEDS_DEPLOY == 'false')
                        ? "No he tocado la raspi: ya tiene esto mismo desplegado, nada que redesplegar."
                        : "No he tocado la raspi."

                def head = inBeta
                    ? "Ring: cambios propios del fork."
                    : (behind == '0')
                    ? "Ring: sin novedades en dgreif/ring esta semana."
                    : "Ring: ${behind} commits nuevos de dgreif/ring mergeados en tu fork."

                def msg = "${head} Build, tests y lint en verde. ${raspi}"
                if (log) { msg += "\n\n${log}" }
                telegram(msg)
            }
        }
        failure {
            // env.STAGE_NAME dentro de post{} vale siempre 'Declarative: Post Actions',
            // no la etapa que rompio: el 23 Sep 2026 un fallo de lint se notifico como
            // fallo de post-acciones y el mensaje no servia para nada. Cada etapa graba
            // su nombre en env.CURRENT_STAGE al entrar, y aqui se usa ese.
            script {
                def msg
                if (fileExists('.merge-conflict')) {
                    msg = "Ring: el merge de dgreif/ring da CONFLICTO con tus cambios del intercom. He abortado el merge, no he tocado nada ni en el repo ni en la raspi. Lo resuelvo yo a mano cuando me digas."
                } else if (fileExists('.needs-pnpm')) {
                    msg = "Ring: dgreif/ring ${readFile('.needs-pnpm').trim()} (estable) usa pnpm y este Jenkinsfile usa npm. No he mergeado ni desplegado nada. Hace falta el Jenkinsfile con pnpm: está en la rama upstream-15-beta de tu fork."
                } else {
                    msg = "Ring: la pipeline semanal ha fallado en la fase '${env.CURRENT_STAGE ?: env.STAGE_NAME}'. Si llegó a desplegar, el script de deploy ya ha hecho rollback solo. Consola: http://192.168.1.240:9123/job/${env.JOB_NAME}/${env.BUILD_NUMBER}/console"
                }
                telegram(msg)
            }
        }
    }
}

// Telegram, never ntfy — ntfy is only for raspi5's own infra crons.
// The text goes through the environment, never interpolated into the shell command:
// a changelog line with a quote or a backtick in it would otherwise be run as code.
boolean telegram(String text) {
    // a return inside the step closures would only leave the closure, so the result goes through a variable
    boolean ok = false
    withCredentials([string(credentialsId: 'telegram_bot_token', variable: 'TG_TOKEN')]) {
        withEnv(["TG_TEXT=${text}"]) {
            // -f: an HTTP error from Telegram is a curl failure and marks the build UNSTABLE, instead
            // of a green build whose notice never arrived (Codex review, 30 Oct 2026)
            int rc = sh(returnStatus: true, script: '''
                curl -fsS -o /dev/null -X POST "https://api.telegram.org/bot${TG_TOKEN}/sendMessage" \
                     --data-urlencode "chat_id=${TELEGRAM_CHAT_ID}" \
                     --data-urlencode "text=${TG_TEXT}"
            ''', label: 'notify Telegram')
            if (rc != 0) {
                unstable("Telegram: aviso no entregado (curl ${rc})")
            } else {
                ok = true
            }
        }
    }
    return ok
}
