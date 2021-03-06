const expressStormpath = require('express-stormpath')
const path = require('path')
const stormpath = require('stormpath')

const analytics = require('./analytics')
const config = require('./config')
const log = require('./log')

const DEFAULT_DIRECTORY = `${config.application.toLowerCase()}-${config.env}`
const VIEW_PATH = path.resolve(__dirname, '../views')

module.exports = expressStormpath

const group = module.exports.group = {
  administrator: () => 'administrator',
  manager: () => 'manager',
  organization: (id) => `organization-${id}`,
  commuter: () => 'commuter'
}

module.exports.initializeStormpathMiddleware = function initializeStormpathMiddleware (app) {
  if (config.stormpath_application_href) {
    app.use('/', expressStormpath.init(app, {
      accountVerification: true,
      forgotPassword: true,
      debug: 'info',
      expand: {
        customData: true,
        groups: true
      },
      postLoginHandler: postLoginHandler,
      postRegistrationHandler: postRegistrationHandler,

      web: {
        forgotPassword: {
          enabled: true,
          view: `${VIEW_PATH}/forgot.jade`
        },
        forgotPasswordChange: {
          view: `${VIEW_PATH}/forgot_change.jade`
        },
        forgotPasswordChangeFailed: {
          view: `${VIEW_PATH}/forgot_change_failed.jade`
        },
        forgotPasswordComplete: {
          view: `${VIEW_PATH}/forgot_complete.jade`
        },
        forgotPasswordEmailSent: {
          view: `${VIEW_PATH}/forgot_email_sent.jade`
        },
        login: {
          view: `${VIEW_PATH}/login.jade`
        },
        register: {
          form: {
            fields: {
              givenName: {
                enabled: true
              },
              registrationCode: {
                enabled: true,
                placeholder: '(optional)',
                label: 'Registration Code',
                name: 'registrationCode',
                required: false,
                type: 'text'
              }
            }
          },
          view: `${VIEW_PATH}/register.jade`
        },
        unauthorized: {
          view: `${VIEW_PATH}/unauthorized.jade`
        },
        accountVerificationComplete: {
          view: `${VIEW_PATH}/verification_complete.jade`
        },
        accountVerificationEmailSent: {
          view: `${VIEW_PATH}/verification_email_sent.jade`
        },
        accountVerificationFailed: {
          view: `${VIEW_PATH}/verification_failed.jade`
        },
        resendAccountVerification: {
          view: `${VIEW_PATH}/verification_resend.jade`
        },
        verifyEmail: {
          enabled: true,
          view: `${VIEW_PATH}/verification_resend.jade`
        }
      }
    }))

    app.use('/', expressStormpath.getUser, function (req, res, next) {
      req.stormpathApplication = req.app.get('stormpathApplication')
      req.stormpathClient = req.app.get('stormpathClient')
      req.stormpathDirectory = req.app.get('stormpathDirectory')
      res.locals.user = JSON.stringify(req.user)

      if (req.stormpathDirectory) {
        next()
      } else {
        req.stormpathClient.getDirectories({ name: DEFAULT_DIRECTORY }, (err, directories) => {
          if (err) {
            next(err)
          } else {
            req.app.set('stormpathDirectory', directories.items[0])
            req.stormpathDirectory = directories.items[0]
            next()
          }
        })
      }
    })

    app.get('/api/auth/is-logged-in', function (req, res) {
      if (req.user) {
        res.status(200).send(req.user)
      } else {
        res.status(401).end()
      }
    })

    app.get('/api/auth/login-with-link/:link', function (req, res) {
      res.status(200).end()
    })

    app.post('/api/auth/logout', function (req, res) {
      req.stormpathSession.destroy()
      res.status(204).end()
    })
  } else {
    log.warn('Stormpath middleware has not been initialized because credentials have not been provided.')
  }
}

module.exports.createAccount = function createAccount (stormpath, options) {
  if (!options.password) options.password = 'password'
  if (!options.givenName) options.givenName = 'None'
  if (!options.surname) options.surname = 'none'

  return new Promise((resolve, reject) => {
    stormpath.createAccount(options, (err, createdAccount) => {
      if (err) {
        reject(err)
      } else {
        resolve(createdAccount)
      }
    })
  })
}

function postLoginHandler (account, req, res, next) {
  analytics.identify({
    userId: account.href.split('/').pop(),
    traits: {
      givenName: account.givenName,
      surname: account.surname,
      customData: account.customData
    }
  })

  next()
}

/**
 * Create commmuter object. Add to group environment.
 */

function postRegistrationHandler (account, req, res, next) {
  const Commuter = require('./commuter/model')
  Commuter
    .create({
      account: account.href,
      email: account.email,
      givenName: account.givenName,
      surname: account.surname
    })
    .then(() => {
      req.stormpathDirectory.getGroups({ name: group.commuter() }, (err, groups) => {
        if (err) {
          next(err)
        } else {
          groups.eachSeries((group, done) => {
            account.addToGroup(group, done)
          }, next)
        }
      })
    })
    .catch(err => {
      next(err)
    })
}

const getClient = module.exports.getClient = function getClient () {
  return new Promise((resolve, reject) => {
    stormpath.loadApiKey(`${__dirname}/../deployment/stormpath.properties`, (err, apiKey) => {
      if (err) reject(err)
      else resolve(new stormpath.Client({apiKey}))
    })
  })
}

module.exports.getApplication = function getApplication () {
  return new Promise((resolve, reject) => {
    getClient()
      .then(client => {
        client.getApplication(process.env.STORMPATH_APPLICATION_HREF, (err, application) => {
          if (err) {
            reject(err)
          } else {
            resolve(application)
          }
        })
      })
      .catch(reject)
  })
}

module.exports.getDefaultDirectory = function getDefaultDirectory (client, options = {}) {
  return new Promise((resolve, reject) => {
    client.getDirectories({ name: DEFAULT_DIRECTORY }, options, (err, directories) => {
      if (err) {
        reject(err)
      } else {
        resolve(directories.items[0])
      }
    })
  })
}

module.exports.createGroups = function createGroups (directory, names) {
  return Promise.all(names.map(n => {
    return new Promise((resolve, reject) => {
      directory.createGroup({
        name: n
      }, (err, group) => {
        if (err) {
          if (err.code === 2001) resolve(`Group exists for ${n}`)
          else reject(err)
        } else resolve(group)
      })
    })
  }))
}

module.exports.authenticationRequired = function authenticationRequired (req, res, next) {
  if (!req.user) {
    req.stormpathSession.destroy()
    res.status(401).send('Must be logged  in.')
  } else {
    next()
  }
}

module.exports.groupsRequired = function groupsRequired (groups, all = false) {
  return function (req, res, next) {
    if (!req.user) {
      if (req.accepts(['html', 'json']) === 'html') {
        return res.redirect(302, '/login?next=' + encodeURIComponent(req.originalUrl))
      } else {
        return res.status(401).send('Must be logged in.')
      }
    }

    // If this user must be a member of all groups, we'll ensure that is the case
    let done = groups.length
    let safe = false

    req.user.getGroups((err, grps) => {
      if (err) {
        return res.status(404).send(err)
      }

      // Iterate through each group on the user's account, checking to see whether or not it's one of the required groups.
      grps.each((group, c) => {
        if (groups.indexOf(group.name) > -1) {
          if (!all || --done === 0) {
            safe = true
          }
        }
        c()
      }, () => {
        if (!safe) {
          if (req.accepts(['html', 'json']) === 'html') {
            res.redirect(302, '/planner')
          } else {
            res.status(401).send('Access not allowed')
          }
        } else {
          next()
        }
      })
    })
  }
}
