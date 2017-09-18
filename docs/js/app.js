/******************************************************************************/
/* Helper Functions */
/******************************************************************************/

function toBitString(size, bigNumber) {
  var s = bigNumber.toString(2);
  if (s.length < size) {
    s = "0".repeat(size-s.length) + s;
  } else if (s.length > size) {
    s = s.substring(s.length-size);
  }
  return s;
}

/******************************************************************************/
/* Model */
/******************************************************************************/

var Model = function (web3) {
  /* web3 interface */
  this.web3 = web3;
  this.FactoryContract = null;
  this.GameContract = null;

  /* Configuration constants */
  this.defaultGasPrice = null;
  this.tipAddress = null;

  /* State */
  this.factoryInstance = null;
  this.gameInstance = null;
  this.version = null;
  this.gameList = [];
  this.activeGame = {address: null, size: null, description: null, cells: null};

  /* Blockchain event watchers */
  this.gameCreatedEvent = null;
  this.gameStateUpdatedEvent = null;

  /* Callbacks */
  this.connectedCallback = null;
  this.gameAddedCallback = null;
  this.gameStateUpdatedCallback = null;
};

Model.prototype = {
  init: function () {
    var self = this;

    $.getJSON('config.json', function (config) {
      var network_id = self.web3.version.network;

      self.GameContract = self.web3.eth.contract(config.contracts.Rule110);
      self.FactoryContract = self.web3.eth.contract(config.contracts.Rule110Factory);

      var isConnected = self.web3.isConnected();
      var hasWallet = web3.eth.defaultAccount != undefined;

      /* Check if this network si supported */
      if (config.networks[network_id] == undefined) {
        Logger.log('[Model] Not deployed on network id ' + network_id);
        self.connectedCallback(network_id, null, null, isConnected, hasWallet);
        return;
      }

      Logger.log('[Model] Loading model for network id ' + network_id);

      /* Look up configuration constants */
      self.tipAddress = config.networks[network_id].tipAddress;
      self.defaultGasPrice = web3.toBigNumber(web3.toWei(config.networks[network_id].defaultGasPrice, "gwei"));

      /* Create factory instance */
      self.factoryInstance = self.FactoryContract.at(config.networks[network_id].factoryAddress);

      /* Look up factory version */
      self.factoryInstance.VERSION(function (error, version) {
        if (error) {
          self.connectedCallback(network_id, null, null, isConnected, hasWallet);
        } else {
          /* Save factory version */
          self.version = version;

          self.connectedCallback(network_id, version, self.factoryInstance.address, isConnected, hasWallet);

          /* Create event watcher for game created */
          self.gameCreatedEvent = self.factoryInstance.GameCreated(null, {fromBlock: 0, toBlock: 'latest'}, self.handleGameCreatedEvent.bind(self));
        }
      });
    });
  },

  /* Blockchain event handlers */

  handleGameCreatedEvent: function (error, result) {
    if (error) {
      Logger.error(error);
    } else {
      var address = result.args.game;
      var size = result.args.size;
      var description = this.web3.toUtf8(result.args.description);

      Logger.log("[Model] Game created at " + address + ", with size " + size + ", and description " + description);

      var index = this.gameList.length;

      /* Save it to our list */
      this.gameList.push({address: address, size: size, description: description});

      /* Notify our callback */
      this.gameAddedCallback(index, address, size, description);
    }
  },

  handleGameStateUpdatedEvent: function (error, result) {
    if (error) {
      Logger.error(error);
    } else {
      var cells = toBitString(this.activeGame.size, result.args.cells);
      var txid = result.transactionHash;

      this.activeGame.cells.push(cells);

      Logger.log("[Model] Game state updated with cells " + cells + " from txid " + txid);

      /* Notify our callback */
      this.gameStateUpdatedCallback(cells, txid);
    }
  },

  /* Operations */

  selectGame: function (index, callback) {
    /* Look up by game by index */
    var address = this.gameList[index].address;
    var size = this.gameList[index].size;
    var description = this.gameList[index].description;

    Logger.log("[Model] Selecting game at address " + address + ", with size " + size + ", and description " + description);

    /* Form contract instance */
    this.gameInstance = this.GameContract.at(address);

    /* Save active game information */
    this.activeGame.address = address;
    this.activeGame.description = description;
    this.activeGame.size = size;
    this.activeGame.cells = [];

    /* Cancel existing watch handler */
    if (this.gameStateUpdatedEvent)
      this.gameStateUpdatedEvent.stopWatching();

    /* Register watch handler for game state events */
    this.gameStateUpdatedEvent = this.gameInstance.GameStateUpdated(null, {fromBlock: 0, toBlock: 'latest'}, this.handleGameStateUpdatedEvent.bind(this));

    /* Notify our callback */
    callback({address: address, size: size, description: description});
  },

  evolveGame: function (callback) {
    if (!this.gameInstance)
      callback("No game selected.", null);
    else
      this.gameInstance.evolve({gasPrice: this.defaultGasPrice}, callback);
  },

  createGame: function (size, initialCells, description, callback) {
    if (!this.factoryInstance)
      callback("Factory instance not found.", null);
    else
      this.factoryInstance.newRule110(size, initialCells, description, {gasPrice: this.defaultGasPrice}, callback);
  },

  tip: function (amount, callback) {
    web3.eth.sendTransaction({to: this.tipAddress, value: web3.toWei(amount, 'ether'), gasPrice: this.defaultGasPrice}, callback);
  },
};

/******************************************************************************/
/* View */
/******************************************************************************/

var NETWORK_NAME = {
  1: "Mainnet",
  3: "Ropsten",
  4: "Rinkeby",
  42: "Kovan",
};

var NETWORK_BLOCK_EXPLORER = {
  1: "https://etherscan.io",
  3: "https://ropsten.etherscan.io",
  4: "https://rinkeby.etherscan.io",
  42: "https://kovan.etherscan.io",
};

var View = function () {
  /* State */
  this.gameSelectedElement = null;
  this.networkState = {id: null, factoryVersion: null, factoryAddress: null, isConnected: false, hasWallet: false};

  /* Callbacks */
  this.buttonGameSelectCallback = null;
  this.buttonEvolveCallback = null;
  this.buttonCreateCallback = null;
  this.buttonTipCallback = null;
};

View.prototype = {
  init: function () {
    /* Bind buttons */
    $('#evolve-button').click(this.handleButtonEvolve.bind(this));
    $('#create-button').click(this.handleButtonCreate.bind(this));
    $('#tip-button').click(this.handleButtonTip.bind(this));

    /* Bind create inputs */
    $('#create-initial-cells').on('input', this.handleCreateInputsChange.bind(this));
    $('#create-size').on('input', this.handleCreateInputsChange.bind(this));

    /* Generate random 256 initial cells for create game */
    var s = "0x";
    for (var i = 0; i < 64; i++)
        s = s + Math.floor(16*Math.random()).toString("16");
    $('#create-initial-cells').val(s);
    $('#create-size').val("256");
    $('#create-description').val("random");

    /* Set default tip amount to 0.003 ETH */
    $('#tip-amount').val("0.003");

    /* Update create initial board */
    this.handleCreateInputsChange();
  },

  /* Event update handlers */

  handleConnectedEvent: function (networkId, factoryVersion, factoryAddress, isConnected, hasWallet) {
    this.networkState.id = networkId;
    this.networkState.factoryVersion = factoryVersion;
    this.networkState.factoryAddress = factoryAddress;
    this.networkState.isConnected = isConnected;
    this.networkState.hasWallet = hasWallet;

    /* Update network name in status bar */
    var networkName = NETWORK_NAME[networkId] || ("Unknown (" + networkId + ")");
    $('#status-bar-network').append($('<b></b>').addClass('text-info').text(networkName));

    /* Update version in status bar */
    if (factoryVersion) {
      $('#status-bar-version').append($('<b></b>')
                                .addClass('text-info')
                                .append(this.formatAddressLink(
                                   factoryAddress,
                                   "v" + factoryVersion,
                                   true)));
    } else {
      $('#status-bar-version').append($('<b></b>').addClass('text-danger').text("Not Deployed"));
      this.showResultModal(false, "Unsupported network", "This Ðapp has not been deployed to this network.<br><br>Please try mainnet or a testnet network.");
    }

    /* Update wallet status in status bar */
    if (hasWallet) {
      $('#status-bar-wallet').append($('<b></b>').addClass('text-info').text("True"));
    } else {
      $('#status-bar-wallet').append($('<b></b>').addClass('text-danger').text("False"));
    }

    /* Enable tip button if connected and user has wallet */
    if (isConnected && hasWallet)
      $('#tip-button').prop('disabled', false);

    /* Enable create button if connected, deployed, and user has wallet */
    if (isConnected && factoryAddress && hasWallet)
      $('#create-button').prop('disabled', false);
  },

  handleGameAddedEvent: function (index, address, size, description) {
    Logger.log("[View] Adding game with address " + address + ", size " + size + ", and description " + description);

    /* Create row for game list */
    var elem = $('<tr></tr>')
                .append($('<td></td>')
                  .addClass('mono')
                  .append($('<a />')
                    .attr('href', '#')
                    .text(address)
                    .click(this.handleButtonGameSelect.bind(this, index))))
                .append($('<td></td>')
                    .text(size))
                .append($('<td></td>')
                    .text(description));

    /* Add to game list */
    $('#game-list').find("tbody").first().append(elem);

    /* Select first game, if a game hasn't been selected yet */
    if (this.gameSelectedElement == null)
      this.handleButtonGameSelect(0);
  },

  handleGameStateUpdatedEvent: function (cells, txid) {
    Logger.log("[View] Updating game cells");

    /* Replace bit strings with spaces / unicode blocks */
    cells = cells.replace(/0/g, " ");
    cells = cells.replace(/1/g, "█");

    /* Add row to game board */
    $('#game .board').append($('<span></span>')
                              .html(this.formatTxidLink(txid, cells)))
                     .append($('<br/>'));
  },

  /* Button handlers */

  handleButtonGameSelect: function (index) {
    Logger.log("[View] Game select button clicked, index " + index);

    /* Disable evolve button until game is loaded */
    $('#evolve-button').prop('disabled', true);

    /* Clear game information */
    $('#game-address').text("");
    $('#game-size').text("");
    $('#game-description').text("");

    /* Clear game board */
    $('#game .board').empty();

    var self = this;

    this.buttonGameSelectCallback(index, function (result) {
      Logger.log("[View] Game select, index " + index);

      /* Update active element in game list */
      if (self.gameSelectedElement)
        self.gameSelectedElement.removeClass('table-info');

      self.gameSelectedElement = $('#game-list').find("tbody")
                                                .find("tr")
                                                .eq(index)
                                                .addClass('table-info');

      /* Enable evolve button if connected and user has wallet */
      if (self.networkState.isConnected && self.networkState.hasWallet)
        $('#evolve-button').prop('disabled', false);

      /* Update game information */
      $('#game-address').append(self.formatAddressLink(result.address, result.address, true));
      $('#game-size').text(result.size);
      $('#game-description').text(result.description);
    });
  },

  handleButtonEvolve: function () {
    Logger.log("[View] Evolve button clicked");

    var self = this;

    this.buttonEvolveCallback(function (error, txid) {
      if (error) {
        Logger.log("[View] Evolve failed");
        Logger.error(error);

        var msg = $("<span></span>").text(error.message.split('\n')[0]);
        self.showResultModal(false, "Evolve failed", msg);
      } else {
        Logger.log("[View] Evolve succeeded, txid " + txid);

        var msg = $("<span></span>").text("Transaction ID: ")
                                    .append(self.formatTxidLink(txid, txid, true));
        self.showResultModal(true, "Evolve succeeded", msg);
      }
    });
  },

  handleButtonCreate: function () {
    Logger.log("[View] Create button clicked");

    var initialCells = $('#create-initial-cells').val();
    var size = $('#create-size').val();
    var description = $('#create-description').val();

    /* Validate cells are a number */
    try {
      initialCells = web3.toBigNumber(initialCells);
    } catch (err) {
      this.showResultModal(false, "Error", "Invalid game initial cells: initial cells must be a number.");
      return;
    }

    /* Validate size is a number */
    size = Number(size);
    if (isNaN(size)) {
      this.showResultModal(false, "Error", "Invalid game size: game size must be a number.");
      return;
    }

    /* Validate number of cells is in range */
    if (size < 3 || size > 256) {
      this.showResultModal(false, "Error", "Invalid game size: size is out of range, min is 3, max is 256.");
      return;
    }

    /* Validate initial cells are in range */
    if (initialCells.greaterThan(web3.toBigNumber(2).pow(size).minus(1))) {
      this.showResultModal(false, "Error", "Invalid game initial cells: greater than game size.");
      return;
    }

    /* Validate description is 32 chars or less */
    if (description.length > 32) {
      this.showResultModal(false, "Error", "Invalid game description: length is too long, got " + description.length + " characters, max is 32.");
      return;
    }

    var self = this;

    this.buttonCreateCallback(size, initialCells, description, function (error, txid) {
      if (error) {
        Logger.log("[View] Create failed");
        Logger.error(error);

        var msg = $("<span></span>").text(error.message.split('\n')[0]);
        self.showResultModal(false, "Create game failed", msg);
      } else {
        Logger.log("[View] Create succeeded, txid " + txid);

        /* FIXME get new game address */

        var msg = $("<span></span>").text("Transaction ID: ")
                                    .append(self.formatTxidLink(txid, txid, true));
        self.showResultModal(true, "Create game succeeded", msg);
      }
    });
  },

  handleButtonTip: function () {
    Logger.log("[View] Tip button clicked");

    var amount = $('#tip-amount').val();

    /* Validate amount is a number */
    if (isNaN(amount)) {
      this.showResultModal(false, "Error", "Tip amount is not a number.");
      return;
    }

    var self = this;

    this.buttonTipCallback(amount, function (error, txid) {
      if (error) {
        Logger.log("[View] Tip failed");
        Logger.error(error);

        var msg = $("<span></span>").text(error.message.split('\n')[0]);
        self.showResultModal(false, "Tip failed", msg);
      } else {
        Logger.log("[View] Tip succeeded, txid " + txid);

        var msg = $("<span></span>").text("Transaction ID: ")
                                    .append(self.formatTxidLink(txid, txid, true));
        self.showResultModal(true, "Tip succeeded", msg);
      }
    });
  },

  /* From input handlers */

  handleCreateInputsChange: function () {
    var initialCells = $('#create-initial-cells').val();
    var size = $('#create-size').val();

    try {
      initialCells = toBitString(Number(size), web3.toBigNumber(initialCells));

      /* Replace bit strings with spaces / unicode blocks */
      initialCells = initialCells.replace(/0/g, " ");
      initialCells = initialCells.replace(/1/g, "█");

      /* Add to game create board */
      $('#game-create .board').html($('<span></span>')
                                     .text(initialCells));
    } catch (err) { }
  },

  /* Success/failure Modal */

  showResultModal: function (success, heading, body) {
    if (success) {
      $('#result-modal .modal-title').text(heading)
                                     .removeClass('text-danger')
                                     .addClass('text-info');
    } else {
      $('#result-modal .modal-title').text(heading)
                                     .removeClass('text-info')
                                     .addClass('text-danger');
    }

    $('#result-modal .modal-body').html(body);

    $('#result-modal').modal();
  },

  /* Helper functions to format block explorer links */

  formatTxidLink: function (txid, text, addIcon) {
    var baseUrl = NETWORK_BLOCK_EXPLORER[this.networkState.id];

    if (baseUrl) {
      var elem = $('<a></a>')
                 .attr('href', baseUrl + "/tx/" + txid)
                 .attr('target', '_blank')
                 .text(text);

      if (addIcon)
        elem = elem.append($('<i></i>').addClass('icon-link-ext'));

      return elem;
    } else {
      return text;
    }
  },

  formatAddressLink: function (address, text, addIcon) {
    var baseUrl = NETWORK_BLOCK_EXPLORER[this.networkState.id];

    if (baseUrl) {
      var elem = $('<a></a>')
                 .attr('href', baseUrl + "/address/" + address)
                 .attr('target', '_blank')
                 .text(text);

      if (addIcon)
        elem = elem.append($('<i></i>').addClass('icon-link-ext'));

      return elem;
    } else {
      return text;
    }
  },
};

/******************************************************************************/
/* Controller */
/******************************************************************************/

var Controller = function (model, view) {
  this.model = model;
  this.view = view;
};

Controller.prototype = {
  init: function () {
    /* Bind model -> view */
    this.model.connectedCallback = this.view.handleConnectedEvent.bind(this.view);
    this.model.gameAddedCallback = this.view.handleGameAddedEvent.bind(this.view);
    this.model.gameStateUpdatedCallback = this.view.handleGameStateUpdatedEvent.bind(this.view);

    /* Bind view -> model */
    this.view.buttonGameSelectCallback = this.model.selectGame.bind(this.model);
    this.view.buttonEvolveCallback = this.model.evolveGame.bind(this.model);
    this.view.buttonCreateCallback = this.model.createGame.bind(this.model);
    this.view.buttonTipCallback = this.model.tip.bind(this.model);

    /* Initialize view */
    this.view.init();

    /* Initialize model */
    this.model.init();
  },
};

/******************************************************************************/
/* Top-level */
/******************************************************************************/

Logger = {
  enabled: false,

  log: function (s) {
    if (Logger.enabled && console)
      console.log(s);
  },

  error: function (s) {
    console.error(s);
  },
};

App = {
  model: null,
  view: null,
  controller: null,

  init: function () {
    if (typeof web3 !== 'undefined') {
      window.web3 = new Web3(web3.currentProvider);
    } else {
      window.web3 = new Web3(new Web3.providers.HttpProvider('http://localhost:8545'));
    }

    App.model = new Model(window.web3);
    App.view = new View();
    App.controller = new Controller(App.model, App.view);

    App.controller.init();
  },
};

$(function () {
  $(window).on('load', function () {
    App.init();
  });
});