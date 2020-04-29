const { Formatter } = require('cucumber');
const ReportPortalClient = require('reportportal-client');
const utils = require('./utils');
const Context = require('./context');
const DocumentStorage = require('./documents-storage');
const itemFinders = require('./itemFinders');
const { AFTER_HOOK_URI_TO_SKIP, STATUSES } = require('./constants');

const createRPFormatterClass = (config) => {
  const documentsStorage = new DocumentStorage();
  const reportportal = new ReportPortalClient(config);
  const attributesConf = !config.attributes ? [] : config.attributes;
  const isScenarioBasedStatistics = utils.isScenarioBasedStatistics(config);

  return class CucumberReportPortalFormatter extends Formatter {
    constructor(options) {
      super(options);
      this.contextState = new Context();
      this.documentsStorage = documentsStorage;
      this.reportportal = reportportal;
      this.attributesConf = attributesConf;
      this.isScenarioBasedStatistics = isScenarioBasedStatistics;

      const { rerun, rerunOf } = options.parsedArgvOptions || {};

      this.isRerun = rerun || config.rerun;
      this.rerunOf = rerunOf || config.rerunOf;

      options.eventBroadcaster.on('gherkin-document', this.onGherkinDocument.bind(this));
      options.eventBroadcaster.on('pickle-accepted', this.onPickleAccepted.bind(this));
      options.eventBroadcaster.on('test-case-prepared', this.onTestCasePrepared.bind(this));
      options.eventBroadcaster.on('test-case-started', this.onTestCaseStarted.bind(this));
      options.eventBroadcaster.on('test-step-started', this.onTestStepStarted.bind(this));
      options.eventBroadcaster.on('test-step-finished', this.onTestStepFinished.bind(this));
      options.eventBroadcaster.on('test-step-attachment', this.onTestStepAttachment.bind(this));
      options.eventBroadcaster.on('test-case-finished', this.onTestCaseFinished.bind(this));
      options.eventBroadcaster.on('test-run-finished', this.onTestRunFinished.bind(this));
    }

    onGherkinDocument(event) {
      this.documentsStorage.cacheDocument(event);

      // BeforeFeatures
      if (!this.contextState.context.launchId) {
        const launch = this.reportportal.startLaunch({
          name: config.launch,
          startTime: this.reportportal.helpers.now(),
          description: !config.description ? '' : config.description,
          attributes: this.attributesConf,
          rerun: this.isRerun,
          rerunOf: this.rerunOf,
        });
        this.contextState.context.launchId = launch.tempId;
      }
    }

    onPickleAccepted(event) {
      const isPickleCached = this.documentsStorage.isAcceptedPickleCached(event);

      if (!isPickleCached) {
        this.documentsStorage.cacheAcceptedPickle(event);

        const featureDocument = itemFinders.findFeature(
          this.documentsStorage.gherkinDocuments,
          event,
        );
        const featureUri = utils.getUri(event.uri);
        const description = featureDocument.description ? featureDocument.description : featureUri;
        const { name } = featureDocument;
        const itemAttributes = utils.createAttributes(featureDocument.tags);

        let total = featureDocument.children.length;
        featureDocument.children.forEach((child) => {
          if (child.examples) {
            child.examples.forEach((ex) => {
              total += ex.tableBody.length - 1;
            });
          }
        });

        this.contextState.context.background = itemFinders.findBackground(featureDocument);
        if (this.contextState.context.background) {
          total -= 1;
        }

        this.contextState.context.scenariosCount[featureUri] = { total, done: 0 };

        // BeforeFeature
        const featureId = this.reportportal.startTestItem(
          {
            name,
            startTime: this.reportportal.helpers.now(),
            type: this.isScenarioBasedStatistics ? 'TEST' : 'SUITE',
            description,
            attributes: itemAttributes,
          },
          this.contextState.context.launchId,
        ).tempId;

        this.documentsStorage.pickleDocuments[event.uri].featureId = featureId;
      }
    }

    onTestCasePrepared(event) {
      this.contextState.context.stepDefinitions = event;
      this.contextState.context.isBeforeHook = true;
    }

    onTestCaseStarted(event) {
      this.contextState.context.scenario = itemFinders.findScenario(
        this.documentsStorage.gherkinDocuments,
        event.sourceLocation,
      );
      const featureTags = itemFinders.findFeature(
        this.documentsStorage.gherkinDocuments,
        event.sourceLocation,
      ).tags;
      const pickle = this.documentsStorage.pickleDocuments[utils.getUri(event.sourceLocation.uri)];
      const keyword = this.contextState.context.scenario.keyword
        ? this.contextState.context.scenario.keyword
        : this.contextState.context.scenario.type;
      let name = [keyword, this.contextState.context.scenario.name].join(': ');
      const pickleTags = pickle.tags
        ? pickle.tags.filter((tag) => !featureTags.find(utils.createTagComparator(tag)))
        : [];
      const itemAttributes = utils.createAttributes(pickleTags);
      const description =
        this.contextState.context.scenario.description ||
        [utils.getUri(event.sourceLocation.uri), event.sourceLocation.line].join(':'); // TODO codeRef
      const { featureId } = this.documentsStorage.pickleDocuments[event.sourceLocation.uri];

      if (this.contextState.context.lastScenarioDescription !== name) {
        this.contextState.context.lastScenarioDescription = name;
        this.contextState.context.outlineRow = 0;
      } else if (event.attemptNumber < 2) {
        this.contextState.context.outlineRow++;
        name += ` [${this.contextState.context.outlineRow}]`;
      }

      // BeforeScenario
      if (this.isScenarioBasedStatistics || event.attemptNumber < 2) {
        this.contextState.context.scenarioId = this.reportportal.startTestItem(
          {
            name,
            startTime: this.reportportal.helpers.now(),
            type: this.isScenarioBasedStatistics ? 'STEP' : 'TEST',
            description,
            attributes: itemAttributes,
            retry: false,
          },
          this.contextState.context.launchId,
          featureId,
        ).tempId;
      }
    }

    onTestStepStarted(event) {
      this.contextState.context.stepStatus = 'failed';
      this.contextState.context.stepId = null;

      this.contextState.context.stepSourceLocation = this.contextState.context.stepDefinitions.steps[
        event.index
      ];

      // skip After Hook added by protractor-cucumber-framework
      if (
        !this.contextState.context.stepSourceLocation.sourceLocation &&
        this.contextState.context.stepSourceLocation.actionLocation.uri.includes(
          AFTER_HOOK_URI_TO_SKIP,
        )
      )
        return;

      this.contextState.context.step = this.contextState.findStep(event);
      this.contextState.context.stepDefinition = itemFinders.findStepDefinition(
        this.contextState.context,
        event,
      );

      // BeforeStep
      const args = [];
      // if (context.step.arguments && context.step.arguments.rows.length) { // TODO parameters
      //   context.step.arguments.rows.forEach((row) => {
      //     const line = row.cells.map((cell) => cell.value);
      //     args.push(`|${line.join('|').trim()}|`);
      //   });
      // }

      const name = this.contextState.context.step.text
        ? `${this.contextState.context.step.keyword} ${this.contextState.context.step.text}`
        : this.contextState.context.step.keyword;
      const type = utils.getStepType(this.contextState.context.step.keyword);

      this.contextState.context.stepId = this.reportportal.startTestItem(
        {
          name,
          startTime: this.reportportal.helpers.now(),
          type,
          description: args.length ? args.join('\n').trim() : '',
          hasStats: !this.isScenarioBasedStatistics,
          retry: !this.isScenarioBasedStatistics && event.testCase.attemptNumber > 1,
        },
        this.contextState.context.launchId,
        this.contextState.context.scenarioId,
      ).tempId;
    }

    onTestStepFinished(event) {
      // skip After Hook added by protractor-cucumber-framework
      if (
        !this.contextState.context.stepSourceLocation.sourceLocation &&
        this.contextState.context.stepSourceLocation.actionLocation.uri.includes(
          AFTER_HOOK_URI_TO_SKIP,
        )
      )
        return;

      // StepResult
      const sceenshotName = this.contextState.getFileName();

      switch (event.result.status) {
        case STATUSES.PASSED: {
          this.contextState.context.stepStatus = STATUSES.PASSED;
          this.contextState.context.scenarioStatus = STATUSES.PASSED;
          break;
        }
        case STATUSES.PENDING: {
          this.reportportal.sendLog(this.contextState.context.stepId, {
            time: this.reportportal.helpers.now(),
            level: 'WARN',
            message: "This step is marked as 'pending'",
          });
          this.contextState.context.stepStatus = STATUSES.NOT_IMPLEMENTED;
          this.contextState.context.scenarioStatus = STATUSES.FAILED;
          this.contextState.countFailedScenarios(event.testCase.sourceLocation.uri);
          break;
        }
        case STATUSES.UNDEFINED: {
          this.reportportal.sendLog(this.contextState.context.stepId, {
            time: this.reportportal.helpers.now(),
            level: 'ERROR',
            message: 'There is no step definition found. Please verify and implement it.',
          });
          this.contextState.context.stepStatus = STATUSES.NOT_FOUND;
          this.contextState.context.scenarioStatus = STATUSES.FAILED;
          this.contextState.countFailedScenarios(event.testCase.sourceLocation.uri);
          break;
        }
        case STATUSES.AMBIGUOUS: {
          this.reportportal.sendLog(this.contextState.context.stepId, {
            time: this.reportportal.helpers.now(),
            level: 'ERROR',
            message:
              'There are more than one step implementation. Please verify and reimplement it.',
          });
          this.contextState.context.stepStatus = STATUSES.NOT_FOUND;
          this.contextState.context.scenarioStatus = STATUSES.FAILED;
          this.contextState.countFailedScenarios(event.testCase.sourceLocation.uri);
          break;
        }
        case STATUSES.SKIPPED: {
          this.contextState.context.stepStatus = STATUSES.SKIPPED;
          if (this.contextState.context.scenarioStatus === STATUSES.FAILED) {
            this.contextState.context.scenarioStatus = STATUSES.SKIPPED;
          }
          break;
        }
        case STATUSES.FAILED: {
          this.contextState.context.stepStatus = STATUSES.FAILED;
          this.contextState.countFailedScenarios(event.testCase.sourceLocation.uri);
          const errorMessage = `${
            this.contextState.context.stepDefinition.uri
          }\n ${event.result.exception.toString()}`;
          this.reportportal.sendLog(this.contextState.context.stepId, {
            time: this.reportportal.helpers.now(),
            level: 'ERROR',
            message: errorMessage,
          });
          if (global.browser && config.takeScreenshot && config.takeScreenshot === 'onFailure') {
            const request = {
              time: this.reportportal.helpers.now(),
              level: 'ERROR',
              file: { name: sceenshotName },
              message: sceenshotName,
            };
            global.browser.takeScreenshot().then((png) => {
              const fileObj = {
                name: sceenshotName,
                type: 'image/png',
                content: png,
              };
              this.reportportal.sendLog(this.contextState.context.stepId, request, fileObj);
            });
          }
          break;
        }
        default:
          break;
      }

      // AfterStep
      const request = {
        status: this.contextState.context.stepStatus,
        endTime: this.reportportal.helpers.now(),
      };
      if (request.status === STATUSES.NOT_FOUND) {
        request.status = STATUSES.FAILED;
        request.issue = {
          issueType: 'ab001',
          comment: 'STEP DEFINITION WAS NOT FOUND',
        };
      } else if (request.status === STATUSES.NOT_IMPLEMENTED) {
        request.status = STATUSES.SKIPPED;
        request.issue = {
          issueType: 'ti001',
          comment: 'STEP IS PENDING IMPLEMENTATION',
        };
      }

      this.reportportal.finishTestItem(this.contextState.context.stepId, request);
    }

    onTestStepAttachment(event) {
      const fileName = this.contextState.getFileName();

      if (
        event.data &&
        event.data.length &&
        (this.contextState.context.stepStatus === 'passed' ||
          this.contextState.context.stepStatus === 'failed')
      ) {
        switch (event.media.type) {
          case 'text/plain': {
            const logMessage = utils.getJSON(event.data);
            const request = {
              time: this.reportportal.helpers.now(),
            };
            if (logMessage) {
              request.level = logMessage.level;
              request.message = logMessage.message;
            } else {
              request.level = 'DEBUG';
              request.message = event.data;
            }
            this.reportportal.sendLog(this.contextState.context.stepId, request);
            break;
          }
          default: {
            const request = {
              time: this.reportportal.helpers.now(),
              level: this.contextState.context.stepStatus === 'passed' ? 'DEBUG' : 'ERROR',
              message: fileName,
              file: {
                name: fileName,
              },
            };
            const parsedObject = utils.getJSON(event.data);
            if (parsedObject) {
              request.level = parsedObject.level;
              request.message = parsedObject.message;
              request.file.name = parsedObject.message;
            }
            const fileObj = {
              name: fileName,
              type: event.media.type,
              content: (parsedObject && parsedObject.data) || event.data,
            };
            this.reportportal.sendLog(this.contextState.context.stepId, request, fileObj);
            break;
          }
        }
      }
    }

    onTestCaseFinished(event) {
      if (!this.isScenarioBasedStatistics && event.result.retried) {
        return;
      }
      const isFailed = event.result.status.toUpperCase() !== 'PASSED';
      // ScenarioResult
      this.reportportal.finishTestItem(this.contextState.context.scenarioId, {
        status: isFailed ? STATUSES.FAILED : STATUSES.PASSED,
        endTime: this.reportportal.helpers.now(),
      });
      this.contextState.context.scenarioStatus = STATUSES.FAILED;
      this.contextState.context.scenarioId = null;

      const featureUri = event.sourceLocation.uri;
      if (!event.result.retried) {
        this.contextState.context.scenariosCount[featureUri].done++;
      }
      const { total, done } = this.contextState.context.scenariosCount[featureUri];
      if (done === total) {
        const featureStatus =
          this.contextState.context.failedScenarios[featureUri] > 0
            ? STATUSES.FAILED
            : STATUSES.PASSED;
        this.reportportal.finishTestItem(
          this.documentsStorage.pickleDocuments[featureUri].featureId,
          {
            status: featureStatus,
            endTime: this.reportportal.helpers.now(),
          },
        );
      }
    }

    onTestRunFinished() {
      // AfterFeatures
      const promise = this.reportportal.getPromiseFinishAllItems(
        this.contextState.context.launchId,
      );
      promise.then(() => {
        if (this.contextState.context.launchId) {
          const launchFinishPromise = this.reportportal.finishLaunch(
            this.contextState.context.launchId,
            {
              endTime: this.reportportal.helpers.now(),
            },
          ).promise;
          launchFinishPromise.then(() => {
            this.contextState.resetContext();
          });
        }
      });
    }
  };
};

module.exports = { createRPFormatterClass };
