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
            when { expression { params.DEPLOY } }
            steps {
                script { env.CURRENT_STAGE = env.STAGE_NAME }
                sh '''
                    set -e
                    cd packages/homebridge-ring
                    # Exactly what the plugin needs at runtime. lib/ is the tsc output,
                    # rebuilt from scratch by `npm run build`, so it cannot carry stale
                    # files from a previous revision.
                    tar czf "${STAGE_TARBALL}" lib media config.schema.json package.json homebridge-ui
                    ls -l "${STAGE_TARBALL}"
                '''
            }
        }

        stage('Deploy to Homebridge') {
            when { expression { params.DEPLOY } }
            steps {
                script { env.CURRENT_STAGE = env.STAGE_NAME }
                sh 'sudo -n /usr/local/bin/deploy-ring-fork.sh "${STAGE_TARBALL}"'
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
                def behind = fileExists('.upstream-behind') ? readFile('.upstream-behind').trim() : '?'
                def log = fileExists('.upstream-changelog') ? readFile('.upstream-changelog').trim() : ''

                // Whether the raspi was touched depends on the Deploy stage having run,
                // NOT on whether upstream moved. The first version tied the two together
                // and told Miguel "no he tocado la raspi" on a run that had just deployed.
                def raspi = (env.DEPLOYED == 'true')
                    ? "Desplegado en homebridge de la raspi5."
                    : "No he tocado la raspi."

                def head = (behind == '0')
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
void telegram(String text) {
    withCredentials([string(credentialsId: 'telegram_bot_token', variable: 'TG_TOKEN')]) {
        withEnv(["TG_TEXT=${text}"]) {
            sh(script: '''
                curl -s -o /dev/null -X POST "https://api.telegram.org/bot${TG_TOKEN}/sendMessage" \
                     --data-urlencode "chat_id=${TELEGRAM_CHAT_ID}" \
                     --data-urlencode "text=${TG_TEXT}"
            ''', label: 'notify Telegram')
        }
    }
}
