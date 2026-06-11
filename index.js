const express = require("express");
const cors = require("cors");
const { MongoClient, ServerApiVersion } = require("mongodb");

require("dotenv").config();

const app = express();
const port = process.env.PORT || 3000;

const admin = require("firebase-admin");

const serviceAccount = require("./firebase-admin-key.json");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);


// console.log(process.env.CLIENT_DOMAIN);



// middleware
app.use(
  cors({
    origin: [process.env.CLIENT_DOMAIN , "http://localhost:5173" ],

    credentials: true,
    optionSuccessStatus: 200,
  }),
);



app.use(express.json());

const uri = process.env.MONGO_URI;

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

// jwt middlewares
const verifyJWT = async (req, res, next) => {
  const token = req?.headers?.authorization?.split(" ")[1];
  console.log(token);
  if (!token) return res.status(401).send({ message: "Unauthorized Access!" });
  try {
    const decoded = await admin.auth().verifyIdToken(token);
    req.tokenEmail = decoded.email;
    console.log(decoded);
    next();
  } catch (err) {
    console.log(err);
    return res.status(401).send({ message: "Unauthorized Access!", err });
  }
};

async function run() {
  try {
    // await client.connect()

    const db = client.db("LocalChefBazaar");
    const mealsCollection = db.collection("meals");
    const ordersCollection = db.collection("orders");
    const usersCollection = db.collection("users");
    const sellerRequestsCollection = db.collection("sellerRequests");
    const reviewsCollection = db.collection("review");

    // role middlewares
    const verifyADMIN = async (req, res, next) => {
      const email = req.tokenEmail;
      const user = await usersCollection.findOne({ email });
      if (user?.role !== "admin")
        return res
          .status(403)
          .send({ message: "Admin only Actions!", role: user?.role });

      next();
    };
    const verifySELLER = async (req, res, next) => {
      const email = req.tokenEmail;
      const user = await usersCollection.findOne({ email });
      if (user?.role !== "seller")
        return res
          .status(403)
          .send({ message: "Seller only Actions!", role: user?.role });

      next();
    };

    // Add meals in the database
    app.post("/meals", async (req, res) => {
      const mealData = req.body;
      console.log("Received:", mealData);

      const result = await mealsCollection.insertOne(mealData);

      res.send(result);
    });


    

    // Get all data from database

    app.get("/meals", async (req, res) => {
      const meals = await mealsCollection.find().toArray();
      res.send(meals);
    });

    const { ObjectId } = require("mongodb");

    // get data click view details

    app.get("/meals/:id", async (req, res) => {
      const id = req.params.id;

      const result = await mealsCollection.findOne({
        _id: new ObjectId(id),
      });
      res.send(result);
    });

    app.post("/create-checkout-session", async (req, res) => {
      const paymentInfo = req.body;

      const session = await stripe.checkout.sessions.create({
        line_items: [
          {
            price_data: {
              currency: "usd",
              product_data: {
                name: paymentInfo?.foodName,
                description: paymentInfo?.deliveryArea,
                images: [paymentInfo?.foodImage],
              },
              unit_amount: paymentInfo?.price * 100,
            },
            quantity: paymentInfo?.quantity,
          },
        ],
        customer_email: paymentInfo?.customer?.email,
        mode: "payment",
        metadata: {
          mealId: paymentInfo?._id,
          foodName: paymentInfo?.foodName,
          customer: paymentInfo?.customer?.email,
          quantity: paymentInfo?.quantity,
        },
        success_url: `${process.env.CLIENT_DOMAIN}/payment-success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${process.env.CLIENT_DOMAIN}/meal/${paymentInfo?._id}`,
      });

      res.send({ url: session.url });
    });

    //Payment success
    app.post("/payment-success", async (req, res) => {
      try {
        const { sessionId } = req.body;

        const session = await stripe.checkout.sessions.retrieve(sessionId);

        const meal = await mealsCollection.findOne({
          _id: new ObjectId(session.metadata.mealId),
        });

        const order = await ordersCollection.findOne({
          transactionId: session.payment_intent,
        });

        if (session.status === "complete" && meal && !order) {
          const orderInfo = {
            mealId: session.metadata.mealId,
            transactionId: session.payment_intent,
            customer: session.metadata.customer,
            status: "pending",

            // seller: meal.chefName,
            name: meal.foodName,
            seller: {
              name: meal.chefName,
              email: meal.userEmail,
              // image: meal.chefImage,
            },

            category: meal.category,
            quantity: Number(session.metadata.quantity),

            price: session.amount_total / 100,
            image: meal?.foodImage,
          };

          const result = await ordersCollection.insertOne(orderInfo);

          await mealsCollection.updateOne(
            { _id: new ObjectId(session.metadata.mealId) },
            { $inc: { quantity: -Number(session.metadata.quantity) } },
          );

          return res.send({
            transactionId: session.payment_intent,
            orderId: result.insertedId,
          });
        }

        return res.send({
          transactionId: session.payment_intent,
          orderId: order?._id || null,
        });
      } catch (error) {
        console.error("payment-success error:", error);
        res.status(500).send({ message: error.message });
      }
    });

    //get all data from OrderList :

    app.get("/my-orders", verifyJWT, async (req, res) => {
      const email = req.tokenEmail;

      if (!email) {
        return res.status(400).send({ message: "Email required" });
      }

      const result = await ordersCollection.find({ customer: email }).toArray();

      res.send(result);
    });

    //get all order for seller email

    app.get(
      "/manage-orders/:email",
      verifyJWT,
      verifySELLER,
      async (req, res) => {
        const email = req.params.email;
        const result = await ordersCollection
          .find({ "seller.email": email })
          .toArray();
        res.send(result);
      },
    );

    //get all meal  for seller by email

    app.get(
      "/my-inventory/:email",
      verifyJWT,
      verifySELLER,
      async (req, res) => {
        const email = req.params.email;

        const result = await mealsCollection
          .find({
            userEmail: email,
          })
          .toArray();
        res.send(result);
      },
    );

    // save or update a user in db
    app.post("/user", async (req, res) => {
      const userData = req.body;
      userData.created_at = new Date().toISOString();
      userData.last_loggedIn = new Date().toISOString();
      userData.role = "customer";

      const query = {
        email: userData.email,
      };

      const alreadyExists = await usersCollection.findOne(query);
      console.log("User Already Exists---> ", !!alreadyExists);

      if (alreadyExists) {
        console.log("Updating user info......");
        const result = await usersCollection.updateOne(query, {
          $set: {
            last_loggedIn: new Date().toISOString(),
          },
        });
        return res.send(result);
      }

      console.log("Saving new user info......");
      const result = await usersCollection.insertOne(userData);
      res.send(result);
    });

    app.get("/user/role", verifyJWT, async (req, res) => {
      const result = await usersCollection.findOne({ email: req.tokenEmail });
      res.send({ role: result?.role });
    });

    // save become-seller request
    app.post("/become-seller", verifyJWT, async (req, res) => {
      const email = req.tokenEmail;
      const alreadyExists = await sellerRequestsCollection.findOne({ email });
      if (alreadyExists)
        return res
          .status(409)
          .send({ message: "Already requested,Please wait." });

      const result = await sellerRequestsCollection.insertOne({ email });
      res.send(result);
    });

    // get all seller requests for admin
    app.get("/seller-requests", verifyJWT, verifyADMIN, async (req, res) => {
      const result = await sellerRequestsCollection.find().toArray();
      res.send(result);
    });

    // get all users for admin
    app.get("/users", verifyJWT, verifyADMIN, async (req, res) => {
      const adminEmail = req.tokenEmail;
      const result = await usersCollection
        .find({ email: { $ne: adminEmail } })
        .toArray();
      res.send(result);
    });

    // update a user's role
    app.patch("/update-role", verifyJWT, verifyADMIN, async (req, res) => {
      const { email, role } = req.body;
      const result = await usersCollection.updateOne(
        { email },
        { $set: { role } },
      );
      await sellerRequestsCollection.deleteOne({ email });
      res.send(result);
    });

    app.get("/reviews", async (req, res) => {
      const result = await reviewsCollection.find().toArray();
      res.send(result);
    });

    // await client.db("admin").command({ ping: 1 })
    console.log("✅ MongoDB connected successfully!");
  } catch (error) {
    console.log("❌ MongoDB error:", error);
  }
}

run();

app.get("/", (req, res) => {
  res.send("Server is running");
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
