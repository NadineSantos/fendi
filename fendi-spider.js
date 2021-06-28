const Config = require('./config'),
      BaseSpider = require('./base/base-spider'),
      Helpers = require('./helpers'),
      itemsPerPage = 36;

      class FendiSpider extends BaseSpider{
        constructor(config, logger, dataHandler) {
            super(config, logger, dataHandler);
    
            this.baseUrl = Helpers.formatString(this.config.enterprise.baseUrl, [this.config.countryCode, this.config.category.partialUrl]);
            
            //Selectors
    
           this.popupDialogSelector = 'div [role="dialog"]';
        // this.popupDialogCloseSelector = '#onetrust-accept-btn-handler';
        };
    
        async _retrieveAdditionalProductInfo(currentProduct) {
            let additionalProductInfo = await this.currentPage.evaluate(() => {
                let productVariantsElement = document.querySelectorAll('.detail-accordion .product-detail-accordion .carousel-slide');
                let colors = null;
    
                if(productVariantsElement.length) {
                  productVariantsElement.forEach(function(variant, index) {
                    let value = variant.querySelector('a div').innerText;
            
                    colors += value;
            
                    if(index < productVariantsElement.length - 1) {
                      colors += ", ";
                    }
                  });
                }
                
                return {
                  colors: colors,
                }
              });
    
            currentProduct.Colors = additionalProductInfo.colors;
        };
    
    
        async _getPagesInfo(totalItems, callback) {
            let totalPages = Math.ceil(totalItems / itemsPerPage);
    
            if(callback) {
                await callback(totalPages);
            };
        };
    
        async _scrollToBottom(loadMoreSelector, pageIndex) {
            await this.currentPage.evaluate(() => {
                window.scrollBy(0, window.document.body.scrollHeight);
            });
    
            if(loadMoreSelector && pageIndex > 1) {
                await this._checkItemVisiblity(loadMoreSelector, async () => {
                    await this.currentPage.click(loadMoreSelector);
                });
            }
        };

    
        async _retrieveProductsLists () {
            let partialUrl = this.config.enterprise.partialUrl,
            subCategories = this.config.category.subCategories,
            savedState = this.dataHandler.getSavedState(),
            startSubCategoryIndex = 0;
            
            this.logger.logInfo(`Retrieving products list of subcategories.`);

            this.dataHandler.setPhase(Config.scrapModeEnum.list);

            if(savedState) {
                startSubCategoryIndex = subCategories.findIndex(item => item.name == savedState.name);
    
                this.logger.logInfo(`Resuming session from category ${startSubCategoryIndex + 1} (${subCategories[startSubCategoryIndex].name}).`);
            }
    
            for(let subCategoryIndex = startSubCategoryIndex; subCategoryIndex < subCategories.length; subCategoryIndex++) {
                let subCategory = subCategories[subCategoryIndex],
                    pagesCount = 1,
                    pageIndex = 1,
                    hasResults = null,
                    partialUrl = subCategory.partialUrl,
                    url = `${this.baseUrl}${partialUrl}`,
                    baseSaveObject = {
                        Gender: this.config.genderName,
                        Category: this.config.categoryName,
                        SubCategory: subCategory.name,
                        ShoppingCountry: this.config.country.name,
                        Marketplace: this.config.enterpriseName,
                        Status: BaseSpider.itemStatusEnum.Readen,
                        [this.config.brand.typeName]: this.config.brand.name
                    };
    
                await this._savedCurrentState(subCategory);
    
                let _updatePagesCount = async (totalPages) => {
                    pagesCount = totalPages;
                };
    
                this.logger.logInfo(`Retrieving category ${subCategoryIndex + 1} (${subCategory.name}) of ${subCategories.length}`);
    
                await this._navigateToUrlWithRetry(url, 2);
             
                
            await this._retryRequest(() => new Promise(async (resolve, reject) => {
                try {
                    await Promise.race([
                        //Selectors when has results
                        this._checkItemVisiblity('.products.js-products-container .product-card', () => { hasResults = true; }),
        
                        //Selectors when has no results
                        this._checkItemVisiblity('.products.js-products-container.error-page', () => { hasResults = false; }),
                    ]);

                } catch (error) {
                    var retryError = this.logger.logError(error);
                }

                if(hasResults !== null) {
                    resolve();
                } else {
                    this.logger.logInfo(`Error fetching sub category '${subCategory.name}' items.`);
                    this.logger.logError(retryError);
                    

                    reject();
                }    
            }), 2, true);

            if(!hasResults) {
                if(hasResults === false) {
                    this.logger.logInfo(`Sub category '${subCategory.name}' does not have items.`);
                } else if(hasResults === null) {
                    this.logger.logInfo(`Error fetching sub category '${subCategory.name}' items.`);

                    let screenshot = await this.currentPage.screenshot();
                    await this.dataHandler.sendScreenshotToBucket(screenshot);
                }

                continue;
            }
                //Evaluate items on page, to check if exist more pages
                await this._evaluateItemsPage('.products.js-products-container', 2, async (totalItems) => {
                    if(totalItems >= itemsPerPage) {
                        this._getPagesInfo(totalItems, _updatePagesCount);
                    }
                }, "data-total-items");
    
                this.logger.logInfo(`Sub category '${subCategory.name}' has ${pagesCount} pages.`);
    
                while(true) {
                    try {
                        this.logger.logInfo(`Waiting for images to load from page ${pageIndex} of ${pagesCount} pages.`);
    
                        await this._scrollToBottom('.js-pagination.pagination .load-more', pageIndex);
    
                        await this._retryRequest(() => new Promise(async (resolve, reject) => {
                            try {                      
                                // Wait 5 seconds for all images to finish loading
                                await this.currentPage.waitForTimeout(5000);
    
                                let allImagesLoaded = await this.currentPage.evaluate( () => {    
                                    return document.querySelectorAll('article._loading').length ? false : true;
                                });
                        
                                if (allImagesLoaded) {
                                    this.logger.logInfo("All images loaded.");
                                    resolve()
                                } else {
                                    this.logger.logInfo("Some images did not load yet.");
                                    reject()
                                }
                              } catch(error) {
                                this.logger.logInfo(error);
                                reject();
                              }
                        }), 2, true);
                        
                        this.logger.logInfo(`Retrieving the info of items from page ${pageIndex} of ${pagesCount} pages.`);
    
                        let items = await this.currentPage.evaluate((baseSaveObject, currency) => {
                            const currencyRegExp = /[\d,.\s]*/,
                                  discountRexExp = /[0-9]+%/,
                                  currentDate = new Date();
        
                            let itemElements = document.querySelectorAll('.products.js-products-container'),
                                items = [],
                                originUrl = window.location.origin;
        
                            itemElements.forEach((itemElement) => {
                                let itemUrl = itemElement.querySelector("a").getAttribute("href"),
                                    imageElement =  itemElement.querySelector('.product-card figure'),
                                    imageContent = imageElement.getAttribute("src") ? imageElement.getAttribute("src") : imageElement.getAttribute("data-src"),
                                    productIdElement = itemElement.querySelector('.product-card'),
                                    productId = productIdElement ? productIdElement.getAttribute('data-product-id') : null,
                                    brandColorId = productId.substring(productId.length-4, productId.length),
                                    discountContent = null,
                                    shortDescriptionElement = itemElement.querySelector('.product-info .product-description h2'),
                                    ShortDescriptionContent = shortDescriptionElement ? shortDescriptionElement.innerText.trim() : null,
                                    originalPriceElement = itemElement.querySelector('.product-description .price'),
                                    originalPriceContent = originalPriceElement ? originalPriceElement.innerText.trim().split(" ")[1].replace(".", "").replace(",", "") : null,
                                    currentPriceContent = originalPriceContent ? originalPriceContent : null,
                                    baseStockAndPrice = {
                                        StoreId: "00001",
                                        Size: "Default",
                                        SizeScale: null,
                                        Currency: currency,
                                        Stock: null,
                                        OriginalPrice: originalPriceContent && currencyRegExp.test(originalPriceContent) ? parseFloat(currencyRegExp.exec(originalPriceContent)[0].trim()).toFixed(2) : null,
                                        CurrentPrice: currentPriceContent && currencyRegExp.test(currentPriceContent) ? parseFloat(currencyRegExp.exec(currentPriceContent)[0].trim()).toFixed(2) : null,
                                        Discount: discountContent && discountRexExp.test(discountContent) ? discountRexExp.exec(discountContent)[0].trim() : null,
                                        Date: currentDate.toISOString()
                                    },
                                    item = {
                                        ...baseSaveObject,
                                        ImageUrl: imageContent ? `https:${imageContent}` : null,
                                        ProductUrl: `${originUrl}${itemUrl}`,
                                        ProductId: productId,
                                        BrandColorId: brandColorId,
                                        ShortDescription: ShortDescriptionContent,
                                        Date: currentDate.toISOString(),
                                        OutOfStock: null,
                                        StockAndPrice: [baseStockAndPrice],
                                        SizesAvailable: null,
                                        Colors: null
                                    };
                                items.push(item);
                            });
        
                            return items;
                        }, baseSaveObject, this.config.country.currency);
    
                        this._insertDataItems(items);
                    } catch(error) {
                        this.logger.logError(error);
                        continue;
                    }
    
                    pageIndex++;
    
                    if(pageIndex > pagesCount) {
                        break
                    }
                }
    
                this._removeDuplicates();
            }
            
            await this._savedDataPhase(Config.scrapModeEnum.list);
        };
    
        async _retrieveProductsStock() {
            let products = this.dataHandler.getItems(),
                savedState = this.dataHandler.getSavedState(),
                startProductIndex = 0;
    
            this.dataHandler.setPhase(Config.scrapModeEnum.stock);
    
            this.logger.logInfo(`Retrieving stock info of products!`);
    
            if(savedState) {
                let savedIndex = products.findIndex(item => item.ProductId == savedState.ProductId);
    
                startProductIndex = this._getResumeIndex(savedIndex);
    
                this.logger.logInfo(`Resuming session from product ${startProductIndex + 1} (${products[startProductIndex].ProductId}).`);
            }
            
            for(let productIndex = startProductIndex; productIndex < products.length; productIndex++) {
                let currentDate = new Date().toISOString(),
                    currentProduct = products[productIndex],
                    url = currentProduct.ProductUrl,
                    hasStock = null;
    
                if(currentProduct.Status === BaseSpider.itemStatusEnum.Completed) {
                    continue;
                }
    
                // Set current product's state
                await this._savedCurrentState({
                    ProductId: currentProduct.ProductId,
                    ShortDescription: currentProduct.ShortDescription
                });
    
                this.logger.logInfo(`Retrieving data from product ${productIndex + 1} (${currentProduct.ProductId}) of ${products.length}`);
    
                await this._navigateToUrlWithRetry(url, 2);
    
                await this._evaluateStockExistence(['.product-form', '.js-addtocart'], null, 2 , (result) => {
                    hasStock = result;
                });
    
                if(!hasStock) {
                    this._setProductOutOfStock(currentProduct);
    
                    this.logger.logInfo(`Product ${productIndex + 1} (${currentProduct.ProductId}) is out of stock.`);
    
                    continue;
                }
    
                this.timer.start();
    
                this.logger.logInfo(`Product ${productIndex + 1} (${currentProduct.ProductId}) has stock.`);
    
                // Retrieve missing additional product info (not including stock and sizes)
                await this._retrieveAdditionalProductInfo(currentProduct);
    
                // Retrieve sizes and stocks
                // Check if it has one or multiple sizes
                let hasMultipleSizes = await this._checkIfMultipleSizes('.product-form .selectsize');
    
                let sizesArray = await this._getSizesInfo(currentProduct, hasMultipleSizes);
    
                this.logger.logInfo(`Product ${productIndex + 1} (${currentProduct.ProductId}) has the available sizes: ${currentProduct.SizesAvailable}`);
    
                // Update sizes' info
                for(let i = 0; i < sizesArray.length; i++) {
                    let sizeId = sizesArray[i].sizeId,
                        sizeName = sizesArray[i].sizeName,
                        sizeScale = sizesArray[i].sizeScale,
                        baseStockAndPrice = currentProduct.StockAndPrice[0];
    
                    if(!currentProduct.StockAndPrice[i]) {
                        currentProduct.StockAndPrice[i] = Object.assign({}, baseStockAndPrice);
                    }
    
                    // Save size to the file                  
                    currentProduct.StockAndPrice[i].Size = sizeName;
                    currentProduct.StockAndPrice[i].SizeScale = sizeScale; 
                    currentProduct.Date = currentDate;
    
                    await this._savedCurrentState({
                        ProductId: currentProduct.ProductId,
                        ShortDescription: currentProduct.ShortDescription
                    });
    
                    // Select size from dropdown, if there are multipleSizes
                    if(hasMultipleSizes) {    
                        await this._retryRequest(() => this._selectOption('.product-form .selectsize #select-size-sidebar', sizeId), 2);
                    }
    
                    this.logger.logInfo(`Adding size ${sizeName} to the bag.`);
    
                    // Add size to bag
                    await this._retryRequest(() => Promise.all([
                        this._clickElement('button.js-addtocart'),
                        this._checkItemVisiblity(`.header-nav-bag-list .header-nav-bag-item a[data-product-id="${sizeId}"]`, null)])
                    , 2);
    
                    this.logger.logInfo(`Added size ${sizeName} to the bag.`);
                }
    
                this.logger.logInfo(`All available sizes added to the bag. Going to checkout.`);
    
                await this._navigateToUrlWithRetry(`https://www.fendi.com/${this.config.country.code}`, 2);
    
                this.logger.logInfo(`Checkout completed. Waiting for bag sizes to show.`);
    
                await this._retryRequest(async () => this._checkItemVisiblity('.your-selections .baglist', null, true), 2);
    
                this.logger.logInfo(`Sizes are showing. Updating stock.`);
    
                // Update sizes' stock
                let updatedSizes = await this.currentPage.evaluate((sizesArray, currentProductSizes, currentDate) => {
                    let sizeElements = document.querySelectorAll('.your-selections .baglist .baglist-item-summary');
            
                    sizeElements.forEach((size) => {
                        let stock = parseInt(size.getAttribute('data-item-maxquantity')),
                            sizeId = size.getAttribute('data-item-size-id'),
                            currentSize = sizesArray.find((size) => size.sizeId === sizeId),
                            currentProductSize = currentSize ? currentProductSizes.find((size) => size.Size === currentSize.sizeName) : null;
    
                            if(currentProductSize) {
                                currentProductSize.Stock = stock;
                                currentProductSize.Date = currentDate;
                            }
                    });
            
                    return currentProductSizes;
                }, sizesArray, currentProduct.StockAndPrice, currentDate);
    
                currentProduct.StockAndPrice = updatedSizes;
    
                if(currentProduct.StockAndPrice.some((size) => size.Stock == null)){
                    this.logger.logWarning(`Stock could not be retrieved for some sizes.`);
                } else {
                    this.logger.logInfo(`Stock retrieved for all sizes.`);
                }
    
                // Save the stocks before clearing the cookies, in case if fails
                await this._savedCurrentState({
                    ProductId: currentProduct.ProductId,
                    ShortDescription: currentProduct.ShortDescription
                });
                
                this.logger.logInfo(`Clearing sizes from bag.`);
    
                // Clear bag
                await this._retryRequest(async () => this._clearCookies(), 2);
    
                this.logger.logInfo(`Bag cleared.`);
    
                // Change state to "Complete"
                this.logger.logInfo(`Finish retrieving data from product ${productIndex + 1} (${currentProduct.ProductId}) after ${this.timer.getElapsedTime()}.`);
                this._setProductComplete(currentProduct);
            }
    
            await this._savedDataPhase(Config.scrapModeEnum.stock);
        };
    
        async start() {
            if(!this._validateItemsPhase() && !this.dataHandler.getSavedState()) {
                this.logger.logInfo(`The phase ${this.config.scrapMode} of products are already completed!`);
                return;
            }
            
            await this._newBrowserPage();
            switch(this.config.scrapMode) {
                case Config.scrapModeEnum.list:
                    await this._retrieveProductsLists();
                    break;
                case Config.scrapModeEnum.stock:
                    await this._retrieveProductsStock();
                    break;
            }
            await this._closeBrowserSafely();
        };
    };
    
    module.exports = FendiSpider;